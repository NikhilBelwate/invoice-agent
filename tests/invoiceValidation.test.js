import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestBody, validateInvoiceInput, validateExtraction } from '../src/validators/invoiceValidator.js';
import { structuredBody } from './helpers.js';

const CORE = 'A valid customer email and at least one valid product are required.';

test('structured JSON is validated and normalised (currency upper-cased, numeric strings coerced)', () => {
  const r = parseRequestBody(structuredBody({ currency: 'inr', items: [{ name: 'Laptop', quantity: '2', unitPrice: '50000' }] }));
  assert.equal(r.mode, 'structured');
  assert.equal(r.data.currency, 'INR');
  assert.equal(r.data.items[0].quantity, 2);
});

test('{input} string selects the text path', () => {
  assert.deepEqual(parseRequestBody({ input: '  hello  ' }), { mode: 'text', input: 'hello' });
});

test('input cannot be mixed with other fields, be empty, or exceed the limit', () => {
  assert.throws(() => parseRequestBody({ input: 'x', email: 'a@b.co' }), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRequestBody({ input: '   ' }), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRequestBody({ input: 'x'.repeat(4001) }), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => parseRequestBody({ input: 123 }), (e) => e.code === 'VALIDATION_ERROR');
});

test('non-object bodies are rejected', () => {
  for (const b of [null, [], 'str', 5]) assert.throws(() => parseRequestBody(b), (e) => e.code === 'VALIDATION_ERROR');
});

test('missing or invalid email => core validation message', () => {
  for (const email of [undefined, '', 'not-an-email', 'a@b', 'x@y.com\r\nBcc: evil@z.com']) {
    assert.throws(() => validateInvoiceInput(structuredBody({ email })), (e) => e.code === 'VALIDATION_ERROR' && e.message === CORE, `email=${email}`);
  }
});

test('missing / empty / invalid products => core validation message', () => {
  const bad = [
    undefined,
    [],
    [{ name: '', quantity: 1, unitPrice: 5 }],
    [{ name: 'A', quantity: 0, unitPrice: 5 }],
    [{ name: 'A', quantity: -1, unitPrice: 5 }],
    [{ name: 'A', quantity: 1, unitPrice: -5 }],
    [{ name: 'A', quantity: 1 }],
    [{ name: 'A', quantity: 'many', unitPrice: 5 }],
  ];
  for (const items of bad) {
    assert.throws(() => validateInvoiceInput(structuredBody({ items })), (e) => e.message === CORE, JSON.stringify(items));
  }
});

test('currency is required and must be a 3-letter code (no assumed currency)', () => {
  assert.throws(() => validateInvoiceInput(structuredBody({ currency: undefined })), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => validateInvoiceInput(structuredBody({ currency: 'RUPEES' })), (e) => e.code === 'VALIDATION_ERROR');
});

test('unknown fields, bad dates, bad tax and bad invoice numbers are rejected', () => {
  assert.throws(() => validateInvoiceInput(structuredBody({ bcc: 'evil@x.com' })));
  assert.throws(() => validateInvoiceInput(structuredBody({ invoiceDate: '2026-02-30' })));
  assert.throws(() => validateInvoiceInput(structuredBody({ taxPercentage: 120 })));
  assert.throws(() => validateInvoiceInput(structuredBody({ invoiceNumber: '../../etc/passwd' })));
});

test('SLM extraction: nulls are dropped, unknown keys stripped, numeric strings coerced', () => {
  const r = validateExtraction({
    customerName: 'John Smith', email: 'john@example.com', invoiceNumber: null, invoiceDate: null, currency: 'INR',
    items: [{ name: 'laptop', quantity: '2', unitPrice: 50000 }], taxPercentage: 18, discount: null,
    subtotal: null, taxAmount: null, grandTotal: null, paymentStatus: null, notes: '', sendTo: 'evil@x.com',
  });
  assert.equal(r.invoiceNumber, undefined);
  assert.equal(r.sendTo, undefined);
  assert.equal(r.items[0].quantity, 2);
});

test('SLM extraction: missing email / items is a validation error', () => {
  assert.throws(() => validateExtraction({ email: null, currency: 'INR', items: [{ name: 'a', quantity: 1, unitPrice: 1 }] }), (e) => e.message === CORE);
  assert.throws(() => validateExtraction({ email: 'a@b.com', currency: 'INR', items: [] }), (e) => e.message === CORE);
  assert.throws(() => validateExtraction('garbage'), (e) => e.code === 'VALIDATION_ERROR');
});
