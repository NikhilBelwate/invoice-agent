import { prepareInvoice } from '../agents/invoicePipeline.js';
import { generateInvoicePdf } from '../services/pdfService.js';
import { sendInvoiceEmail } from '../services/emailService.js';
import { idempotency } from '../services/stateStore.js';
import { AppError } from '../utils/errors.js';

const MAX_INLINE_PDF_BYTES = 3_000_000; // keeps the base64 JSON response well under Vercel's 4.5 MB limit
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

// Failures where nothing was delivered and the same call may succeed later.
const RETRYABLE = new Set(['SLM_TIMEOUT', 'SLM_UNAVAILABLE', 'SLM_BAD_RESPONSE', 'EMAIL_FAILED', 'STATE_STORE_UNAVAILABLE']);

// ---- Tool definitions ------------------------------------------------------------------------------
// The authoritative validation is the Zod schema in invoiceValidator.js; this JSON Schema documents it for the model.

const invoiceProperties = {
  input: {
    type: 'string',
    maxLength: 4000,
    description:
      'Plain-text description of the purchase (customer, email, items, prices, currency, tax). Use this OR the structured fields below, not both.',
  },
  customerName: { type: 'string', maxLength: 120 },
  email: { type: 'string', format: 'email', description: 'Customer email address (required for structured input).' },
  currency: { type: 'string', pattern: '^[A-Za-z]{3}$', description: 'ISO 4217 code such as INR, USD, CAD (required; never assumed).' },
  items: {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', maxLength: 200 },
        quantity: { type: 'number', exclusiveMinimum: 0 },
        unitPrice: { type: 'number', minimum: 0, description: 'Price of ONE unit.' },
      },
      required: ['name', 'quantity', 'unitPrice'],
      additionalProperties: false,
    },
  },
  taxPercentage: { type: 'number', minimum: 0, maximum: 100, description: 'Tax rate in percent. Omit if no tax applies; it is never assumed.' },
  discount: {
    type: 'object',
    properties: { type: { enum: ['percentage', 'fixed'] }, value: { type: 'number', minimum: 0 } },
    required: ['type', 'value'],
    additionalProperties: false,
    description: 'Applied to the subtotal before tax.',
  },
  invoiceNumber: { type: 'string', description: 'Optional; generated when omitted.' },
  invoiceDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Optional YYYY-MM-DD; defaults to today (server date).' },
  paymentStatus: { type: 'string', maxLength: 40 },
  notes: { type: 'string', maxLength: 1000 },
  subtotal: { type: 'number', minimum: 0, description: 'Optional. Verified against the calculated value, never trusted.' },
  taxAmount: { type: 'number', minimum: 0, description: 'Optional. Verified against the calculated value, never trusted.' },
  grandTotal: { type: 'number', minimum: 0, description: 'Optional. Verified against the calculated value, never trusted.' },
};

const INPUT_HELP =
  'Provide either "input" (free text) or structured fields (customerName, email, currency, items[], taxPercentage...). ' +
  'All amounts are calculated by the server; supplied totals are only verified.';

export const TOOLS = [
  {
    name: 'generate_invoice_pdf',
    title: 'Generate invoice PDF',
    description:
      `Creates a professional PDF invoice and returns it as an embedded application/pdf resource (base64). Sends no email. ${INPUT_HELP}`,
    inputSchema: { type: 'object', properties: invoiceProperties, additionalProperties: false },
    annotations: { title: 'Generate invoice PDF', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'send_invoice_email',
    title: 'Email invoice to customer',
    description:
      'Creates the PDF invoice and EMAILS it to the customer email address in the invoice data (the only possible recipient). ' +
      'Returns emailSubmitted=true when the SMTP server accepted the message (not proof of inbox delivery). ' +
      `Pass the same idempotencyKey when retrying to guarantee a single email. ${INPUT_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...invoiceProperties,
        idempotencyKey: {
          type: 'string',
          pattern: '^[A-Za-z0-9._:-]{8,128}$',
          description: 'Optional 8-128 chars. Repeating a call with the same key returns the first result and sends no second email.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Email invoice to customer', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

// ---- Results -------------------------------------------------------------------------------------------

const textResult = (text, structured) => ({ content: [{ type: 'text', text }], structuredContent: structured, isError: false });

function describeDetails(details) {
  return (Array.isArray(details) ? details : [])
    .slice(0, 10)
    .map((d) => {
      if (d.problem) return `- ${d.field}: ${d.problem}`;
      const base = `- ${d.field}: supplied ${d.supplied}, calculated ${d.calculated}`;
      return d.reason ? `${base} (${d.reason})` : base;
    });
}

/** Tool EXECUTION errors are results with isError:true so the model can read them and self-correct. */
export function toolError(err) {
  if (err instanceof AppError) {
    const lines = describeDetails(err.details);
    const hint =
      err.code === 'VALIDATION_ERROR' ? 'Fix the listed fields and call the tool again.'
      : err.code === 'FINANCIAL_DISCREPANCY' ? 'Correct the values, or omit subtotal/taxAmount/grandTotal so they are calculated, then call again.'
      : RETRYABLE.has(err.code) ? 'This failure is temporary; the call can be retried. Nothing was emailed.'
      : '';
    return {
      content: [{ type: 'text', text: [err.message, ...lines, hint].filter(Boolean).join('\n') }],
      structuredContent: { error: err.code, retryable: RETRYABLE.has(err.code), ...(err.details ? { details: err.details } : {}) },
      isError: true,
    };
  }
  console.error('[mcp] unexpected tool error:', err?.name ?? 'Error'); // never log message/stack: may contain customer data
  return {
    content: [{ type: 'text', text: 'An unexpected error occurred while processing the invoice.' }],
    structuredContent: { error: 'INTERNAL_ERROR', retryable: false },
    isError: true,
  };
}

function summarize(invoice, extra) {
  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    currency: invoice.currency,
    subtotal: invoice.subtotal,
    discountAmount: invoice.discount?.amount ?? 0,
    taxPercentage: invoice.taxPercentage,
    taxAmount: invoice.taxAmount,
    grandTotal: invoice.grandTotal,
    ...extra,
  };
}

// ---- Executors -------------------------------------------------------------------------------------------

async function generatePdf(args, { config, deps, now }) {
  const invoice = await prepareInvoice(args, { config, deps, now });
  const pdf = await (deps?.generatePdf ?? generateInvoicePdf)(invoice, config.business);
  if (pdf.buffer.length > MAX_INLINE_PDF_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'The generated PDF is too large to return inline; reduce the number of items.', 400);
  }
  const summary = summarize(invoice, { pdfGenerated: true, emailSubmitted: false, filename: pdf.filename, sizeBytes: pdf.buffer.length });
  return {
    content: [
      { type: 'text', text: `Invoice ${invoice.invoiceNumber} generated (${invoice.currency} ${invoice.grandTotal}). The PDF is attached as a resource. No email was sent.` },
      {
        type: 'resource',
        resource: { uri: `invoice://${encodeURIComponent(invoice.invoiceNumber)}/${pdf.filename}`, mimeType: 'application/pdf', blob: pdf.buffer.toString('base64') },
      },
    ],
    structuredContent: summary,
    isError: false,
  };
}

async function emailInvoice(args, { config, store, deps, now }) {
  const { idempotencyKey, ...body } = args;
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(String(idempotencyKey))) {
    throw new AppError('VALIDATION_ERROR', 'idempotencyKey must be 8-128 characters of A-Z a-z 0-9 . _ : -', 400);
  }

  let idemKey;
  if (idempotencyKey !== undefined) {
    const begun = await idempotency.begin(store, `mcp:${idempotencyKey}`);
    if (begun.status === 'done') {
      return textResult(`${begun.response.message} (replayed: no second email was sent)`, { ...begun.response, idempotentReplay: true });
    }
    if (begun.status === 'processing') {
      throw new AppError('DUPLICATE_IN_PROGRESS', 'A call with this idempotencyKey is still being processed. Wait, then call again with the same key.', 409);
    }
    idemKey = begun.key;
  }

  try {
    const invoice = await prepareInvoice(body, { config, deps, now });
    const pdf = await (deps?.generatePdf ?? generateInvoicePdf)(invoice, config.business);
    await (deps?.sendEmail ?? sendInvoiceEmail)(invoice, pdf, config.smtp, config.business);

    const summary = summarize(invoice, {
      pdfGenerated: true,
      emailSubmitted: true,
      message: `Invoice ${invoice.invoiceNumber} generated and submitted to the SMTP server for the customer's email address. Acceptance by SMTP does not confirm inbox delivery.`,
    });
    if (idemKey) await idempotency.complete(store, idemKey, summary).catch(() => console.error('[mcp] failed to record idempotent result'));
    return textResult(summary.message, summary);
  } catch (err) {
    if (idemKey) await idempotency.release(store, idemKey).catch(() => {}); // nothing was sent: allow a retry
    throw err;
  }
}

const EXECUTORS = { generate_invoice_pdf: generatePdf, send_invoice_email: emailInvoice };

/** Runs a tool; business failures become isError results, never thrown. */
export async function runTool(name, args, ctx) {
  try {
    return await EXECUTORS[name](args, ctx);
  } catch (err) {
    return toolError(err);
  }
}
