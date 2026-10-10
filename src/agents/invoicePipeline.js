import { parseRequestBody } from '../validators/invoiceValidator.js';
import { extractInvoiceData } from '../services/slmService.js';
import { calculateInvoice } from '../services/invoiceCalculationService.js';

/**
 * Validate -> (SLM extraction for text input) -> calculate/verify.
 * Returns the calculated invoice WITHOUT generating a PDF or sending anything, so interfaces that
 * need only part of the workflow (e.g. the MCP tools) share exactly the same rules as the REST/A2A path.
 * Throws AppError (VALIDATION_ERROR, FINANCIAL_DISCREPANCY, SLM_*) like processInvoiceRequest().
 */
export async function prepareInvoice(body, { config, deps = {}, now } = {}) {
  const extract = deps.extract ?? extractInvoiceData;
  const request = parseRequestBody(body);
  const input = request.mode === 'text' ? await extract(request.input, config.slm) : request.data;
  return calculateInvoice(input, { now });
}
