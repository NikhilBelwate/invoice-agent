import nodemailer from 'nodemailer';
import { AppError } from '../utils/errors.js';
import { emailSchema } from '../validators/invoiceValidator.js';

let cached = { key: null, transporter: null };

/** Reusable transporter, rebuilt only when the SMTP settings change. */
export function getTransporter(smtp) {
  const key = [smtp.host, smtp.port, smtp.secure, smtp.user].join('|') + `|${smtp.pass?.length ?? 0}`;
  if (cached.key !== key) {
    cached = {
      key,
      transporter: nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    };
  }
  return cached.transporter;
}

export function smtpConfigured(smtp) {
  return Boolean(smtp.host && smtp.user && smtp.pass && smtp.from);
}

export function buildMessage(invoice, pdf, smtp, business = {}) {
  const greeting = invoice.customerName ? `Dear ${invoice.customerName},` : 'Hello,';
  const signOff = business.name ? `${business.name} Billing Team` : 'Billing Team';
  return {
    from: smtp.from,
    to: invoice.email,
    subject: `Your Invoice ${invoice.invoiceNumber}`,
    text: `${greeting}\n\nThank you for your purchase. Please find your invoice attached as a PDF.\n\nBest regards,\n${signOff}\n`,
    attachments: [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }],
  };
}

/**
 * Submit the invoice email to the SMTP server. Never retries.
 * Resolves to { submitted: true } only when the server ACCEPTED the message for the recipient;
 * this does not mean the message reached an inbox.
 */
export async function sendInvoiceEmail(invoice, pdf, smtp, business = {}, { transporter } = {}) {
  if (!emailSchema.safeParse(invoice.email).success) {
    throw new AppError('VALIDATION_ERROR', 'A valid customer email and at least one valid product are required.', 400);
  }
  if (!transporter && !smtpConfigured(smtp)) {
    throw new AppError('CONFIG_ERROR', 'SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM are required).', 503);
  }

  const tx = transporter ?? getTransporter(smtp);
  let info;
  try {
    info = await tx.sendMail(buildMessage(invoice, pdf, smtp, business));
  } catch (err) {
    // Surface only the SMTP error category, never credentials or server banners.
    const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN';
    console.error(`[email] SMTP submission failed (${code})`);
    throw new AppError('EMAIL_FAILED', `The SMTP server did not accept the message (${code}).`, 502);
  }

  const accepted = (info?.accepted ?? []).map((a) => String(a).toLowerCase());
  if (!accepted.includes(invoice.email.toLowerCase())) {
    throw new AppError('EMAIL_FAILED', 'The SMTP server did not accept the recipient address.', 502);
  }
  return { submitted: true, messageId: info.messageId };
}
