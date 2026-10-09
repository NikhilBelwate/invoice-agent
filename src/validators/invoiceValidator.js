import { z } from 'zod';
import { validationError } from '../utils/errors.js';

export const MAX_INPUT_CHARS = 4000;
export const MAX_ITEMS = 100;

const noControlChars = (s) => !/[\u0000-\u001F\u007F]/.test(s);

// Accept plain numbers and plain numeric strings ("50000", "12.5"); reject everything else.
const numeric = z.preprocess(
  (v) => (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v),
  z.number().finite(),
);
const nonNegative = numeric.pipe(z.number().min(0).max(1e12));
const positiveQty = numeric.pipe(z.number().positive().max(1e9));

const text = (max) => z.string().trim().min(1).max(max).refine(noControlChars, 'must not contain control characters');

export const emailSchema = z.string().trim().max(254).email().refine(noControlChars, 'invalid characters');

const currencySchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 code'),
);

const itemSchema = z.object({
  name: text(200),
  quantity: positiveQty,
  unitPrice: nonNegative,
});

const discountSchema = z.object({
  type: z.enum(['percentage', 'fixed']),
  value: nonNegative,
});

const optionalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((s) => new Date(s + 'T00:00:00Z').toISOString().startsWith(s), 'not a real date');

const invoiceFields = {
  customerName: text(120).optional(),
  email: emailSchema,
  invoiceNumber: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,39}$/, 'invalid invoice number').optional(),
  invoiceDate: optionalDate.optional(),
  currency: currencySchema,
  items: z.array(itemSchema).min(1).max(MAX_ITEMS),
  taxPercentage: numeric.pipe(z.number().min(0).max(100)).optional(),
  discount: discountSchema.optional(),
  subtotal: nonNegative.optional(),
  taxAmount: nonNegative.optional(),
  grandTotal: nonNegative.optional(),
  paymentStatus: text(40).optional(),
  notes: text(1000).optional(),
};

export const invoiceInputSchema = z.object(invoiceFields).strict();

// SLM output: every field may be null/empty; those are dropped before strict validation.
const dropNulls = (o) =>
  o && typeof o === 'object' && !Array.isArray(o)
    ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== ''))
    : o;

export const extractionSchema = z.preprocess(
  (raw) => {
    const o = dropNulls(raw);
    if (o && typeof o === 'object') {
      if (Array.isArray(o.items)) o.items = o.items.map(dropNulls);
      if (o.discount) o.discount = dropNulls(o.discount);
    }
    return o;
  },
  z.object(invoiceFields).strip(),
);

const CORE_MSG = 'A valid customer email and at least one valid product are required.';

function fail(zodError) {
  const issues = zodError.issues.map((i) => ({ field: i.path.join('.') || '(root)', problem: i.message }));
  const core = issues.some((i) => i.field === 'email' || i.field === 'items' || i.field.startsWith('items.'));
  return validationError(core ? CORE_MSG : 'Invoice data failed validation.', issues);
}

/** Validate and normalise a structured invoice object. */
export function validateInvoiceInput(obj) {
  const r = invoiceInputSchema.safeParse(obj);
  if (!r.success) throw fail(r.error);
  return r.data;
}

/** Validate SLM output (untrusted). Unknown keys are discarded. */
export function validateExtraction(obj) {
  const r = extractionSchema.safeParse(obj);
  if (!r.success) throw fail(r.error);
  return r.data;
}

const envelopeSchema = z.object({ input: z.string().trim().min(1).max(MAX_INPUT_CHARS) }).strict();

/**
 * Decide which path a request body takes.
 *   { input: "..." }         -> { mode: 'text', input }
 *   structured invoice JSON  -> { mode: 'structured', data }
 */
export function parseRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('Request body must be a JSON object.');
  }
  if ('input' in body) {
    const r = envelopeSchema.safeParse(body);
    if (!r.success) {
      throw validationError(
        `"input" must be a non-empty string of at most ${MAX_INPUT_CHARS} characters and cannot be combined with other fields.`,
      );
    }
    return { mode: 'text', input: r.data.input };
  }
  return { mode: 'structured', data: validateInvoiceInput(body) };
}
