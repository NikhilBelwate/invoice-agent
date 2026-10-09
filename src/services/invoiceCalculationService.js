import { D, roundMoney, minorUnits, toNumber } from '../utils/money.js';
import { AppError } from '../utils/errors.js';
import { generateInvoiceNumber } from '../utils/invoiceNumber.js';

/*
 * Calculation & rounding policy
 * -----------------------------
 * 1. line total      = round(quantity x unitPrice)              (per item, to currency minor units)
 * 2. subtotal        = sum of rounded line totals
 * 3. discount        = percentage: round(subtotal x pct / 100)  | fixed: value
 *                      Applied to the subtotal, before tax. Must not exceed the subtotal.
 * 4. taxable amount  = subtotal - discount
 * 5. tax             = round(taxable x taxPercentage / 100)     (tax is applied AFTER discount)
 * 6. grand total     = subtotal - discount + tax
 * Rounding: ROUND_HALF_UP to the currency's minor unit (JPY 0, KWD 3, default 2).
 * No tax rate is ever assumed: when none is supplied, tax is 0 and taxPercentage is null.
 * Caller-supplied subtotal / taxAmount / grandTotal are verified, never trusted: any difference
 * larger than one minor unit raises FINANCIAL_DISCREPANCY.
 */

export function calculateInvoice(input, { now = new Date() } = {}) {
  const { currency } = input;
  const unit = new D(10).pow(-minorUnits(currency));

  const items = input.items.map((it) => ({
    name: it.name,
    quantity: it.quantity,
    unitPrice: it.unitPrice,
    lineTotal: roundMoney(new D(it.quantity).mul(it.unitPrice), currency),
  }));

  const subtotal = items.reduce((acc, it) => acc.plus(it.lineTotal), new D(0));

  let discount = new D(0);
  if (input.discount) {
    if (input.discount.type === 'percentage') {
      if (input.discount.value > 100) {
        throw new AppError('VALIDATION_ERROR', 'Percentage discount cannot exceed 100.', 400);
      }
      discount = roundMoney(subtotal.mul(input.discount.value).div(100), currency);
    } else {
      discount = roundMoney(input.discount.value, currency);
    }
    if (discount.gt(subtotal)) {
      throw new AppError('VALIDATION_ERROR', 'Discount cannot exceed the subtotal.', 400);
    }
  }

  const taxable = subtotal.minus(discount);
  const hasRate = input.taxPercentage !== undefined;
  const taxAmount = hasRate ? roundMoney(taxable.mul(input.taxPercentage).div(100), currency) : new D(0);
  const grandTotal = taxable.plus(taxAmount);

  const discrepancies = [];
  const check = (field, supplied, calculated) => {
    if (supplied === undefined) return;
    if (new D(supplied).minus(calculated).abs().gt(unit)) {
      discrepancies.push({ field, supplied, calculated: toNumber(calculated) });
    }
  };
  check('subtotal', input.subtotal, subtotal);
  check('taxAmount', input.taxAmount, taxAmount);
  check('grandTotal', input.grandTotal, grandTotal);

  if (input.taxAmount !== undefined && !hasRate && input.taxAmount > 0) {
    discrepancies.push({
      field: 'taxAmount',
      supplied: input.taxAmount,
      calculated: 0,
      reason: 'A tax amount was supplied without a tax percentage; no tax rate is assumed.',
    });
  }

  if (discrepancies.length) {
    throw new AppError(
      'FINANCIAL_DISCREPANCY',
      'Supplied financial values do not match the calculated amounts. Correct or remove them and resubmit.',
      422,
      discrepancies,
    );
  }

  return {
    invoiceNumber: input.invoiceNumber ?? generateInvoiceNumber(now),
    invoiceNumberGenerated: input.invoiceNumber === undefined,
    invoiceDate: input.invoiceDate ?? now.toISOString().slice(0, 10),
    customerName: input.customerName,
    email: input.email,
    currency,
    items: items.map((i) => ({ ...i, lineTotal: toNumber(i.lineTotal) })),
    subtotal: toNumber(subtotal),
    discount: input.discount ? { ...input.discount, amount: toNumber(discount) } : null,
    taxPercentage: hasRate ? input.taxPercentage : null,
    taxAmount: toNumber(taxAmount),
    grandTotal: toNumber(grandTotal),
    paymentStatus: input.paymentStatus,
    notes: input.notes,
  };
}
