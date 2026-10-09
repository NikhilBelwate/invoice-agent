import PDFDocument from 'pdfkit';
import { AppError } from '../utils/errors.js';
import { formatMoney } from '../utils/money.js';
import { generateFilename } from '../utils/invoiceNumber.js';

const MARGIN = 50;
const COLORS = { ink: '#1f2933', muted: '#667085', line: '#d0d5dd', band: '#f2f4f7', accent: '#1d4ed8' };

/**
 * Render the invoice to an in-memory Buffer. Nothing is written to disk.
 * Returns { buffer, filename }.
 */
export async function generateInvoicePdf(invoice, business = {}) {
  try {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: `Invoice ${invoice.invoiceNumber}` } });
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    render(doc, invoice, business);
    doc.end();
    const buffer = await done;
    return { buffer, filename: generateFilename(invoice.invoiceNumber) };
  } catch {
    throw new AppError('PDF_GENERATION_FAILED', 'The invoice PDF could not be generated.', 500);
  }
}

function render(doc, inv, business) {
  const money = (v) => formatMoney(v, inv.currency);
  const left = MARGIN;
  const right = doc.page.width - MARGIN;
  const width = right - left;

  // Header
  doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(24).text('INVOICE', left, MARGIN);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(12);
  if (business.name) doc.text(business.name, left, MARGIN, { width, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
  if (business.email) doc.text(business.email, left, doc.y, { width, align: 'right' });
  if (business.address) doc.text(business.address, left + width / 2, doc.y, { width: width / 2, align: 'right' });

  doc.y = Math.max(doc.y, MARGIN + 34) + 16;
  rule(doc, left, right);

  // Meta + bill-to
  const top = doc.y + 12;
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text('BILL TO', left, top);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(11).text(inv.customerName ?? inv.email, left, top + 13, { width: width / 2 - 10 });
  if (inv.customerName) doc.font('Helvetica').fontSize(10).text(inv.email, { width: width / 2 - 10 });
  const leftEnd = doc.y;

  const metaX = left + width / 2 + 40;
  const meta = [
    ['Invoice No.', inv.invoiceNumber],
    ['Invoice Date', inv.invoiceDate],
    ['Currency', inv.currency],
  ];
  if (inv.paymentStatus) meta.push(['Payment Status', inv.paymentStatus]);
  let my = top;
  for (const [k, v] of meta) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text(k, metaX, my, { width: 90 });
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10).text(String(v), metaX + 92, my - 1, { width: right - metaX - 92, align: 'right' });
    my += 17;
  }
  doc.y = Math.max(leftEnd, my) + 24;

  // Item table
  const col = {
    item: { x: left + 8, w: width - 8 - 60 - 100 - 110 },
    qty: { x: right - 270, w: 60 },
    price: { x: right - 200, w: 90 },
    total: { x: right - 100, w: 96 },
  };
  // item column spans to qty column
  col.item.w = col.qty.x - col.item.x - 8;

  const header = () => {
    const y = doc.y;
    doc.rect(left, y, width, 22).fill(COLORS.band);
    doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(9);
    doc.text('DESCRIPTION', col.item.x, y + 7, { width: col.item.w });
    doc.text('QTY', col.qty.x, y + 7, { width: col.qty.w, align: 'right' });
    doc.text('UNIT PRICE', col.price.x, y + 7, { width: col.price.w, align: 'right' });
    doc.text('AMOUNT', col.total.x, y + 7, { width: col.total.w, align: 'right' });
    doc.y = y + 28;
  };
  header();

  doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink);
  for (const it of inv.items) {
    const nameHeight = doc.heightOfString(it.name, { width: col.item.w });
    if (doc.y + nameHeight + 10 > doc.page.height - MARGIN - 140) {
      doc.addPage();
      header();
      doc.font('Helvetica').fontSize(10).fillColor(COLORS.ink);
    }
    const y = doc.y;
    doc.text(it.name, col.item.x, y, { width: col.item.w });
    doc.text(String(it.quantity), col.qty.x, y, { width: col.qty.w, align: 'right' });
    doc.text(money(it.unitPrice), col.price.x, y, { width: col.price.w, align: 'right' });
    doc.text(money(it.lineTotal), col.total.x, y, { width: col.total.w, align: 'right' });
    doc.y = y + Math.max(nameHeight, 12) + 8;
    rule(doc, left, right, COLORS.line);
    doc.y += 8;
  }

  // Totals
  if (doc.y + 120 > doc.page.height - MARGIN) doc.addPage();
  doc.y += 6;
  const lblX = right - 260;
  const row = (label, value, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(COLORS.ink);
    doc.text(label, lblX, y, { width: 150 });
    doc.text(value, right - 110, y, { width: 110, align: 'right' });
    doc.y = y + (bold ? 22 : 18);
  };
  row('Subtotal', money(inv.subtotal));
  if (inv.discount) {
    const label = inv.discount.type === 'percentage' ? `Discount (${inv.discount.value}%)` : 'Discount';
    row(label, `- ${money(inv.discount.amount)}`);
  }
  row(inv.taxPercentage === null ? 'Tax' : `Tax (${inv.taxPercentage}%)`, money(inv.taxAmount));
  rule(doc, lblX, right);
  doc.y += 6;
  row(`Total (${inv.currency})`, money(inv.grandTotal), true);

  // Notes
  if (inv.notes) {
    doc.y += 14;
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(9).text('NOTES', left, doc.y);
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(10).text(inv.notes, left, doc.y + 3, { width });
  }

  // Footer
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8);
  doc.text('Thank you for your business.', left, doc.page.height - MARGIN - 10, { width, align: 'center', lineBreak: false });
}

function rule(doc, x1, x2, color = COLORS.ink) {
  doc.save().moveTo(x1, doc.y).lineTo(x2, doc.y).lineWidth(0.7).strokeColor(color).stroke().restore();
}
