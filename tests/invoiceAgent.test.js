import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processInvoiceRequest } from '../src/agents/invoiceAgent.js';
import { extractInvoiceData } from '../src/services/slmService.js';
import { generateInvoicePdf } from '../src/services/pdfService.js';
import { sendInvoiceEmail } from '../src/services/emailService.js';
import { AppError } from '../src/utils/errors.js';
import { makeConfig, newStore, structuredBody, fakeDeps } from './helpers.js';

const config = makeConfig();
const run = (body, opts = {}) => processInvoiceRequest(body, { config, ...opts });

// ---- helpers for the real SLM service with a mocked fetch -------------------
const slmReply = (obj) => async () =>
  new Response(JSON.stringify({ message: { role: 'assistant', content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }), { status: 200 });
const goodExtraction = {
  customerName: 'John Smith', email: 'john@example.com', currency: 'INR',
  items: [{ name: 'laptop', quantity: 2, unitPrice: 50000 }], taxPercentage: 18,
};
const TEXT = 'Generate an invoice for John Smith, john@example.com, 2 laptops at 50000 INR each, with 18% tax.';

// ---- JSON path ---------------------------------------------------------------
test('JSON input: processed without calling the SLM', async () => {
  const { deps, calls } = fakeDeps();
  const r = await run(structuredBody(), { deps });
  assert.equal(r.success, true);
  assert.equal(calls.extract, 0);
  assert.deepEqual([calls.pdf, calls.email], [1, 1]);
  assert.equal(r.grandTotal, 119180);
  assert.equal(r.pdfGenerated, true);
  assert.equal(r.emailSubmitted, true);
});

// ---- text path ---------------------------------------------------------------
test('plain text: extracted by (mocked) Gemma, then calculated by Node', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return slmReply(goodExtraction)();
  };
  const { deps, calls } = fakeDeps({ extract: (t, slm) => extractInvoiceData(t, slm, { fetchImpl }) });
  const r = await run({ input: TEXT }, { deps });
  assert.equal(seen.url, 'https://slm.example.com/api/chat');
  assert.equal(seen.body.model, 'gemma3:4b');
  assert.equal(seen.body.format, 'json');
  assert.equal(seen.body.stream, false);
  assert.equal(seen.init.headers.Authorization, 'Bearer slm-secret');
  assert.equal(r.subtotal, 100000);
  assert.equal(r.taxAmount, 18000);
  assert.equal(r.grandTotal, 118000);
  assert.equal(calls.email, 1);
});

test('SLM-provided totals are ignored unless they match what Node calculates', async () => {
  const fetchImpl = slmReply({ ...goodExtraction, grandTotal: 999 });
  const { deps, calls } = fakeDeps({ extract: (t, slm) => extractInvoiceData(t, slm, { fetchImpl }) });
  await assert.rejects(run({ input: TEXT }, { deps }), (e) => e.code === 'FINANCIAL_DISCREPANCY');
  assert.equal(calls.email, 0);
});

// ---- invalid input -> nothing is sent -----------------------------------------
for (const [name, body] of [
  ['missing email', structuredBody({ email: undefined })],
  ['invalid email', structuredBody({ email: 'nope' })],
  ['no items', structuredBody({ items: [] })],
  ['invalid item', structuredBody({ items: [{ name: 'x', quantity: 0, unitPrice: 1 }] })],
]) {
  test(`${name}: VALIDATION_ERROR and no PDF/email`, async () => {
    const { deps, calls } = fakeDeps();
    await assert.rejects(run(body, { deps }), (e) => e.code === 'VALIDATION_ERROR' && e.status === 400);
    assert.deepEqual(calls, { extract: 0, pdf: 0, email: 0 });
  });
}

test('inconsistent supplied totals: 422 and nothing sent', async () => {
  const { deps, calls } = fakeDeps();
  await assert.rejects(run(structuredBody({ grandTotal: 1 }), { deps }), (e) => e.code === 'FINANCIAL_DISCREPANCY' && e.status === 422);
  assert.equal(calls.pdf + calls.email, 0);
});

// ---- SLM failures --------------------------------------------------------------
const textWith = (fetchImpl, cfg = config) => ({
  config: cfg,
  deps: { ...fakeDeps().deps, extract: (t, slm) => extractInvoiceData(t, slm, { fetchImpl }) },
});

test('invalid SLM responses are rejected (not JSON / array / wrong shape / hallucinated email)', async () => {
  const cases = [
    [slmReply('I cannot do that'), 'SLM_BAD_RESPONSE'],
    [slmReply('[1,2]'), 'SLM_BAD_RESPONSE'],
    [async () => new Response('<html>', { status: 200 }), 'SLM_BAD_RESPONSE'],
    [slmReply({ ...goodExtraction, items: [{ name: 'x', quantity: 'lots', unitPrice: 1 }] }), 'VALIDATION_ERROR'],
    [slmReply({ ...goodExtraction, email: 'attacker@evil.com' }), 'VALIDATION_ERROR'], // not in source text
    [slmReply({ ...goodExtraction, email: null }), 'VALIDATION_ERROR'],
  ];
  for (const [fetchImpl, code] of cases) {
    await assert.rejects(processInvoiceRequest({ input: TEXT }, textWith(fetchImpl)), (e) => e.code === code, code);
  }
});

test('SLM fenced JSON is accepted', async () => {
  const r = await processInvoiceRequest({ input: TEXT }, textWith(slmReply('```json\n' + JSON.stringify(goodExtraction) + '\n```')));
  assert.equal(r.success, true);
});

test('SLM timeout => SLM_TIMEOUT 504', async () => {
  const slow = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const cfg = makeConfig({ SLM_TIMEOUT_MS: '1000' });
  await assert.rejects(processInvoiceRequest({ input: TEXT }, textWith(slow, cfg)), (e) => e.code === 'SLM_TIMEOUT' && e.status === 504);
});

test('SLM network failure / HTTP errors map to SLM_UNAVAILABLE without leaking details', async () => {
  const net = async () => { throw new TypeError('connect ECONNREFUSED 10.0.0.5:11434'); };
  await assert.rejects(processInvoiceRequest({ input: TEXT }, textWith(net)), (e) => {
    assert.equal(e.code, 'SLM_UNAVAILABLE');
    assert.doesNotMatch(e.message, /10\.0\.0\.5|ECONNREFUSED/);
    return e.status === 502;
  });
  for (const status of [401, 404, 500]) {
    await assert.rejects(processInvoiceRequest({ input: TEXT }, textWith(async () => new Response('x', { status }))), (e) => e.code === 'SLM_UNAVAILABLE');
  }
});

test('missing SLM_BASE_URL => SLM_NOT_CONFIGURED; Gemma is never silently replaced', async () => {
  const cfg = makeConfig({ SLM_BASE_URL: '' });
  const never = async () => assert.fail('fetch must not be called');
  await assert.rejects(processInvoiceRequest({ input: TEXT }, textWith(never, cfg)), (e) => e.code === 'SLM_NOT_CONFIGURED' && e.status === 503);
});

// ---- PDF / SMTP failures -----------------------------------------------------------
test('PDF generation failure => 500 and no email', async () => {
  const { deps, calls } = fakeDeps({ generatePdf: async () => { throw new AppError('PDF_GENERATION_FAILED', 'boom', 500); } });
  await assert.rejects(run(structuredBody(), { deps }), (e) => e.code === 'PDF_GENERATION_FAILED');
  assert.equal(calls.email, 0);
});

test('real PDF service wraps renderer errors as PDF_GENERATION_FAILED', async () => {
  await assert.rejects(generateInvoicePdf({ invoiceNumber: 'X', currency: 'INR' }), (e) => e.code === 'PDF_GENERATION_FAILED');
});

test('SMTP failure => EMAIL_FAILED 502, no success flags, no credentials in message', async () => {
  const transporter = { sendMail: async () => { throw Object.assign(new Error('535 auth failed for smtp-user:smtp-secret'), { code: 'EAUTH' }); } };
  const deps = { ...fakeDeps().deps, sendEmail: (inv, pdf, smtp, biz) => sendInvoiceEmail(inv, pdf, smtp, biz, { transporter }) };
  await assert.rejects(run(structuredBody(), { deps }), (e) => {
    assert.equal(e.code, 'EMAIL_FAILED');
    assert.doesNotMatch(e.message, /smtp-secret|smtp-user/);
    return e.status === 502;
  });
});

test('SMTP that does not accept the recipient is a failure', async () => {
  const transporter = { sendMail: async () => ({ accepted: [], rejected: ['john@example.com'] }) };
  const deps = { ...fakeDeps().deps, sendEmail: (inv, pdf, smtp, biz) => sendInvoiceEmail(inv, pdf, smtp, biz, { transporter }) };
  await assert.rejects(run(structuredBody(), { deps }), (e) => e.code === 'EMAIL_FAILED');
});

test('email: subject has invoice number, body greets customer, PDF attached, recipient is the validated email', async () => {
  let message;
  const transporter = { sendMail: async (m) => { message = m; return { accepted: [m.to], messageId: '<1@x>' }; } };
  const deps = { ...fakeDeps().deps, sendEmail: (inv, pdf, smtp, biz) => sendInvoiceEmail(inv, pdf, smtp, biz, { transporter }) };
  const r = await run(structuredBody({ invoiceNumber: 'INV-1001' }), { deps });
  assert.equal(r.invoiceNumber, 'INV-1001');
  assert.equal(message.subject, 'Your Invoice INV-1001');
  assert.equal(message.to, 'john@example.com');
  assert.match(message.text, /^Dear John Smith,/);
  assert.equal(message.attachments[0].contentType, 'application/pdf');
});

test('no SMTP configuration => CONFIG_ERROR (no send attempted)', async () => {
  await assert.rejects(
    sendInvoiceEmail({ email: 'a@b.com', invoiceNumber: 'X' }, { buffer: Buffer.from('x'), filename: 'x.pdf' }, {}),
    (e) => e.code === 'CONFIG_ERROR',
  );
});

// ---- Idempotency ------------------------------------------------------------------------
test('duplicate request with the same Idempotency-Key sends only one email and replays the result', async () => {
  const { deps, calls } = fakeDeps();
  const store = newStore();
  const a = await run(structuredBody(), { deps, store, idempotencyKey: 'key-12345678' });
  const b = await run(structuredBody(), { deps, store, idempotencyKey: 'key-12345678' });
  assert.equal(calls.email, 1);
  assert.equal(b.idempotentReplay, true);
  assert.equal(b.invoiceNumber, a.invoiceNumber);
});

test('concurrent duplicate while first is in flight => 409', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { deps, calls } = fakeDeps({ sendEmail: async () => { calls.email++; await gate; return { submitted: true }; } });
  const store = newStore();
  const first = run(structuredBody(), { deps, store, idempotencyKey: 'key-concurrent' });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(run(structuredBody(), { deps, store, idempotencyKey: 'key-concurrent' }), (e) => e.code === 'DUPLICATE_IN_PROGRESS' && e.status === 409);
  release();
  await first;
  assert.equal(calls.email, 1);
});

test('failed attempt releases the key so a corrected retry can proceed', async () => {
  const store = newStore();
  let fail = true;
  const { deps, calls } = fakeDeps({ sendEmail: async () => { if (fail) throw new AppError('EMAIL_FAILED', 'x', 502); calls.email++; return { submitted: true }; } });
  await assert.rejects(run(structuredBody(), { deps, store, idempotencyKey: 'key-retry-01' }));
  fail = false;
  const r = await run(structuredBody(), { deps, store, idempotencyKey: 'key-retry-01' });
  assert.equal(r.success, true);
  assert.equal(calls.email, 1);
});

// ---- End to end -----------------------------------------------------------------------------
test('end to end: text -> Gemma (mock) -> calculation -> real PDF -> SMTP (mock)', async () => {
  let message;
  const transporter = { sendMail: async (m) => { message = m; return { accepted: [m.to] }; } };
  const fetchImpl = slmReply({ ...goodExtraction, items: [...goodExtraction.items, { name: 'mouse', quantity: 1, unitPrice: 1000 }] });
  const deps = {
    extract: (t, slm) => extractInvoiceData(t, slm, { fetchImpl }),
    generatePdf: generateInvoicePdf,
    sendEmail: (inv, pdf, smtp, biz) => sendInvoiceEmail(inv, pdf, smtp, biz, { transporter }),
  };
  const r = await run({ input: TEXT }, { deps });
  assert.equal(r.success, true);
  assert.equal(r.grandTotal, 119180);
  assert.equal(r.message, 'Invoice generated and email submitted successfully.');
  assert.equal(message.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
  assert.match(message.attachments[0].filename, /^invoice-INV-\d{8}-[0-9A-F]{8}-[0-9a-f]{8}\.pdf$/);
});

// ---- OpenAI-compatible provider ----------------------------------------------------------------
const openaiCfg = makeConfig({ SLM_PROVIDER: 'openai-compatible', SLM_BASE_URL: 'https://api.example.com/openai/v1', SLM_MODEL: 'gemma-x' });
const openaiReply = (obj) => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }), { status: 200 });

test('openai-compatible: calls /chat/completions with bearer auth + json mode and parses choices[0]', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return openaiReply(goodExtraction)(); };
  const data = await extractInvoiceData(TEXT, openaiCfg.slm, { fetchImpl });
  assert.equal(seen.url, 'https://api.example.com/openai/v1/chat/completions');
  assert.equal(seen.body.model, 'gemma-x');
  assert.deepEqual(seen.body.response_format, { type: 'json_object' });
  assert.equal(seen.auth, 'Bearer slm-secret');
  assert.equal(data.email, 'john@example.com');
});

test('openai-compatible: retries once without response_format on HTTP 400', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? new Response('unsupported', { status: 400 }) : openaiReply(goodExtraction)();
  };
  const data = await extractInvoiceData(TEXT, openaiCfg.slm, { fetchImpl });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(data.currency, 'INR');
});

test('unknown SLM_PROVIDER => SLM_NOT_CONFIGURED', async () => {
  await assert.rejects(extractInvoiceData(TEXT, { ...openaiCfg.slm, provider: 'carrier-pigeon' }), (e) => e.code === 'SLM_NOT_CONFIGURED');
});
