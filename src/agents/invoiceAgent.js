import { parseRequestBody } from '../validators/invoiceValidator.js';
import { extractInvoiceData } from '../services/slmService.js';
import { calculateInvoice } from '../services/invoiceCalculationService.js';
import { generateInvoicePdf } from '../services/pdfService.js';
import { sendInvoiceEmail } from '../services/emailService.js';
import { idempotency } from '../services/stateStore.js';
import { AppError } from '../utils/errors.js';

const defaultDeps = {
  extract: extractInvoiceData,
  generatePdf: generateInvoicePdf,
  sendEmail: sendInvoiceEmail,
};

/**
 * Core workflow, independent of Vercel. Stages, in order:
 *   validate request -> (SLM extraction, text input only) -> validate -> calculate/verify
 *   -> PDF (in memory) -> SMTP submission.
 * Any failing stage throws an AppError; later stages never run.
 *
 * @param body            parsed JSON request body
 * @param opts.config     result of getConfig()
 * @param opts.idempotencyKey  optional client-supplied key; same key => at most one email
 * @param opts.store      state store (required when idempotencyKey is used)
 * @param opts.deps       overrides for extract / generatePdf / sendEmail (tests)
 */
export async function processInvoiceRequest(body, { config, idempotencyKey, store, deps = {}, now } = {}) {
  const d = { ...defaultDeps, ...deps };
  const request = parseRequestBody(body);

  let idemKey;
  if (idempotencyKey) {
    if (!store) throw new AppError('CONFIG_ERROR', 'Idempotency requires a state store.', 503);
    let begun;
    try {
      begun = await idempotency.begin(store, idempotencyKey);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('STATE_STORE_UNAVAILABLE', 'Duplicate-send protection is unavailable; the request was not processed.', 503);
    }
    if (begun.status === 'done') return { ...begun.response, idempotentReplay: true };
    if (begun.status === 'processing') {
      throw new AppError('DUPLICATE_IN_PROGRESS', 'A request with this Idempotency-Key is already being processed.', 409);
    }
    idemKey = begun.key;
  }

  try {
    const input = request.mode === 'text' ? await d.extract(request.input, config.slm) : request.data;
    const invoice = calculateInvoice(input, { now });
    const pdf = await d.generatePdf(invoice, config.business);
    await d.sendEmail(invoice, pdf, config.smtp, config.business);

    const response = {
      success: true,
      invoiceNumber: invoice.invoiceNumber,
      invoiceNumberGenerated: invoice.invoiceNumberGenerated,
      invoiceDate: invoice.invoiceDate,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      discountAmount: invoice.discount?.amount ?? 0,
      taxPercentage: invoice.taxPercentage,
      taxAmount: invoice.taxAmount,
      grandTotal: invoice.grandTotal,
      pdfGenerated: true,
      emailSubmitted: true,
      message: 'Invoice generated and email submitted successfully.',
    };

    if (idemKey) {
      // The email is already submitted; a failure to record it must not turn into an error response.
      await idempotency.complete(store, idemKey, response).catch(() => console.error('[idempotency] failed to record result'));
    }
    return response;
  } catch (err) {
    // Nothing was sent (the email stage is last and throws only on rejection), so allow a corrected retry.
    if (idemKey) await idempotency.release(store, idemKey).catch(() => {});
    throw err;
  }
}
