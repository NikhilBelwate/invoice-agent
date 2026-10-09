import Decimal from 'decimal.js';

// Isolated constructor so we never mutate global Decimal settings.
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

// Minor-unit digits per ISO 4217 currency. Unlisted currencies default to 2.
const MINOR_UNITS = {
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, UGX: 0, PYG: 0,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3,
};

export const minorUnits = (currency) => MINOR_UNITS[currency] ?? 2;

/** Rounding policy: ROUND_HALF_UP to the currency's minor unit. */
export const roundMoney = (value, currency) => new D(value).toDecimalPlaces(minorUnits(currency), D.ROUND_HALF_UP);

export const toNumber = (d) => d.toNumber();

export function formatMoney(value, currency) {
  const digits = minorUnits(currency);
  const fixed = new D(value).toFixed(digits);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}${frac ? '.' + frac : ''}`;
}
