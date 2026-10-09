import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateInvoice } from '../src/services/invoiceCalculationService.js';
import { validateInvoiceInput } from '../src/validators/invoiceValidator.js';
import { structuredBody } from './helpers.js';

const calc = (extra) => calculateInvoice(validateInvoiceInput(structuredBody(extra)), { now: new Date('2026-03-05T10:00:00Z') });

test('multiple products: line totals, subtotal, 18% tax, grand total', () => {
  const r = calc();
  assert.deepEqual(r.items.map((i) => i.lineTotal), [100000, 1000]);
  assert.equal(r.subtotal, 101000);
  assert.equal(r.taxAmount, 18180);
  assert.equal(r.grandTotal, 119180);
});

test('spec example: 2 x 50000 at 18% => 100000 / 18000 / 118000', () => {
  const r = calc({ items: [{ name: 'Laptop', quantity: 2, unitPrice: 50000 }] });
  assert.equal(r.subtotal, 100000);
  assert.equal(r.taxAmount, 18000);
  assert.equal(r.grandTotal, 118000);
});

test('percentage discount is applied before tax', () => {
  const r = calc({ items: [{ name: 'A', quantity: 1, unitPrice: 1000 }], discount: { type: 'percentage', value: 10 } });
  assert.equal(r.discount.amount, 100);
  assert.equal(r.taxAmount, 162); // (1000-100) * 18%
  assert.equal(r.grandTotal, 1062);
});

test('fixed discount is applied before tax', () => {
  const r = calc({ items: [{ name: 'A', quantity: 1, unitPrice: 1000 }], discount: { type: 'fixed', value: 200 } });
  assert.equal(r.taxAmount, 144);
  assert.equal(r.grandTotal, 944);
});

test('decimal-safe arithmetic (0.1 + 0.2 style cases)', () => {
  const r = calc({ items: [{ name: 'A', quantity: 3, unitPrice: 0.1 }, { name: 'B', quantity: 1, unitPrice: 0.2 }], taxPercentage: undefined });
  assert.equal(r.subtotal, 0.5);
  assert.equal(r.grandTotal, 0.5);
});

test('rounds half up to currency minor units (USD 2dp, JPY 0dp)', () => {
  const usd = calc({ currency: 'USD', items: [{ name: 'A', quantity: 1, unitPrice: 10.05 }], taxPercentage: 10 });
  assert.equal(usd.taxAmount, 1.01); // 1.005 -> 1.01
  const jpy = calc({ currency: 'JPY', items: [{ name: 'A', quantity: 1, unitPrice: 105 }], taxPercentage: 10 });
  assert.equal(jpy.taxAmount, 11); // 10.5 -> 11
});

test('no tax percentage => no tax, taxPercentage is null (rate never invented)', () => {
  const r = calc({ taxPercentage: undefined });
  assert.equal(r.taxPercentage, null);
  assert.equal(r.taxAmount, 0);
  assert.equal(r.grandTotal, r.subtotal);
});

test('generates invoice number and server date when absent; keeps supplied ones', () => {
  const r = calc();
  assert.match(r.invoiceNumber, /^INV-20260305-[0-9A-F]{8}$/);
  assert.equal(r.invoiceNumberGenerated, true);
  assert.equal(r.invoiceDate, '2026-03-05');
  const s = calc({ invoiceNumber: 'INV-1001', invoiceDate: '2026-01-02' });
  assert.equal(s.invoiceNumber, 'INV-1001');
  assert.equal(s.invoiceDate, '2026-01-02');
  assert.equal(s.invoiceNumberGenerated, false);
});

test('consistent supplied totals are accepted', () => {
  const r = calc({ subtotal: 101000, taxAmount: 18180, grandTotal: 119180 });
  assert.equal(r.grandTotal, 119180);
});

test('inconsistent supplied totals raise FINANCIAL_DISCREPANCY listing each field', () => {
  assert.throws(
    () => calc({ subtotal: 90000, grandTotal: 1 }),
    (e) => e.code === 'FINANCIAL_DISCREPANCY' && e.status === 422 && e.details.map((d) => d.field).join() === 'subtotal,grandTotal',
  );
});

test('tax amount without a tax percentage is rejected', () => {
  assert.throws(() => calc({ taxPercentage: undefined, taxAmount: 500 }), (e) => e.code === 'FINANCIAL_DISCREPANCY');
});

test('discount larger than subtotal is rejected', () => {
  assert.throws(() => calc({ discount: { type: 'fixed', value: 999999 } }), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => calc({ discount: { type: 'percentage', value: 150 } }), (e) => e.code === 'VALIDATION_ERROR');
});
