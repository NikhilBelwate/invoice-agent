import { randomBytes } from 'node:crypto';

/**
 * Generates INV-YYYYMMDD-XXXXXXXX (32 bits of randomness).
 * NOT guaranteed globally unique: no persistent store checks for collisions.
 */
export function generateInvoiceNumber(now = new Date()) {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `INV-${ymd}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export function generateFilename(invoiceNumber) {
  const safe = String(invoiceNumber).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return `invoice-${safe}-${randomBytes(4).toString('hex')}.pdf`;
}
