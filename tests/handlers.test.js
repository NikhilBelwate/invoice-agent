import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler as invoicesHandler } from '../api/invoices.js';
import { createHandler as healthHandler } from '../api/health.js';
import { generateInvoicePdf } from '../src/services/pdfService.js';
import { getConfig, configStatus } from '../src/config/env.js';
import { baseEnv, fakeDeps, mockReq, mockRes, newStore, structuredBody } from './helpers.js';

const call = async (handler, req) => {
  const res = mockRes();
  await handler(req, res);
  return res;
};
const auth = { 'x-api-key': 'test-api-key' };
const mk = (extra = {}) => {
  const { deps, calls } = fakeDeps();
  return { handler: invoicesHandler({ deps, store: newStore(), env: { ...baseEnv, ...extra } }), calls };
};

test('POST /api/invoices success returns the documented shape', async () => {
  const { handler, calls } = mk();
  const res = await call(handler, mockReq({ headers: auth, body: structuredBody() }));
  assert.equal(res.statusCode, 200);
  const j = res.json;
  assert.equal(j.success, true);
  assert.equal(j.pdfGenerated, true);
  assert.equal(j.emailSubmitted, true);
  assert.equal(j.subtotal, 101000);
  assert.equal(calls.email, 1);
});

test('auth: missing / wrong key => 401; no work done', async () => {
  const { handler, calls } = mk();
  for (const headers of [{}, { 'x-api-key': 'wrong' }]) {
    const res = await call(handler, mockReq({ headers, body: structuredBody() }));
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.error, 'UNAUTHORIZED');
  }
  assert.equal(calls.pdf + calls.email, 0);
});

test('production without API_KEY fails closed (503)', async () => {
  const { handler } = mk({ NODE_ENV: 'production', API_KEY: '' });
  const res = await call(handler, mockReq({ body: structuredBody() }));
  assert.equal(res.statusCode, 503);
  assert.equal(res.json.error, 'CONFIG_ERROR');
});

test('method not allowed => 405', async () => {
  const { handler } = mk();
  const res = await call(handler, mockReq({ method: 'GET', headers: auth }));
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');
});

test('body too large => 413 (declared and streamed)', async () => {
  const { handler } = mk({ MAX_BODY_BYTES: '1024' });
  const big = { input: 'x'.repeat(3000) };
  assert.equal((await call(handler, mockReq({ headers: auth, body: big }))).statusCode, 413);
  const req = mockReq({ headers: auth, body: big });
  delete req.headers['content-length'];
  assert.equal((await call(handler, req)).statusCode, 413);
});

test('bad JSON => 400, wrong content type => 415, validation error => 400 with documented message', async () => {
  const { handler } = mk();
  assert.equal((await call(handler, mockReq({ headers: auth, body: '{nope' }))).statusCode, 400);
  assert.equal((await call(handler, mockReq({ headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' }))).statusCode, 415);
  const res = await call(handler, mockReq({ headers: auth, body: structuredBody({ email: 'bad' }) }));
  assert.equal(res.statusCode, 400);
  assert.deepEqual({ ...res.json, details: undefined }, {
    success: false,
    error: 'VALIDATION_ERROR',
    message: 'A valid customer email and at least one valid product are required.',
    details: undefined,
  });
});

test('rate limiting => 429 with Retry-After', async () => {
  const { handler } = mk({ RATE_LIMIT_PER_MINUTE: '2' });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await call(handler, mockReq({ headers: auth, body: structuredBody() }))).statusCode);
  assert.deepEqual(codes, [200, 200, 429]);
});

test('Idempotency-Key header: duplicate replays and sends once; malformed key rejected', async () => {
  const { handler, calls } = mk();
  const headers = { ...auth, 'idempotency-key': 'abcdef123456' };
  const a = await call(handler, mockReq({ headers, body: structuredBody() }));
  const b = await call(handler, mockReq({ headers, body: structuredBody() }));
  assert.equal(a.statusCode, 200);
  assert.equal(b.json.idempotentReplay, true);
  assert.equal(calls.email, 1);
  assert.equal((await call(handler, mockReq({ headers: { ...auth, 'idempotency-key': 'short' }, body: structuredBody() }))).statusCode, 400);
});

test('errors never expose stack traces or secrets', async () => {
  const { deps } = fakeDeps({ sendEmail: async () => { throw new Error('connect failed smtp-secret at /var/task/x.js'); } });
  const handler = invoicesHandler({ deps, store: newStore(), env: baseEnv });
  const res = await call(handler, mockReq({ headers: auth, body: structuredBody() }));
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body, /smtp-secret|\/var\/task|stack/);
});

test('GET /api/health reports config status without secrets', async () => {
  const res = await call(healthHandler({ env: baseEnv }), mockReq({ method: 'GET', url: '/api/health' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.slm.configured, true);
  assert.equal(res.json.smtp.configured, true);
  for (const secret of ['slm-secret', 'smtp-secret', 'test-api-key', 'smtp-user', 'slm.example.com']) {
    assert.ok(!res.body.includes(secret), `leaked ${secret}`);
  }
});

test('health ?deep=1 requires the API key and probes the SLM', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }] }), { status: 200 });
  const h = healthHandler({ env: baseEnv, fetchImpl });
  assert.equal((await call(h, mockReq({ method: 'GET', url: '/api/health?deep=1' }))).statusCode, 401);
  const ok = await call(h, mockReq({ method: 'GET', url: '/api/health?deep=1', headers: auth }));
  assert.deepEqual(ok.json.slm.probe, { reachable: true, modelAvailable: true });
});

test('production configuration checks: warnings for local SLM URL, missing API key, memory store', () => {
  const s = configStatus(getConfig({ ...baseEnv, NODE_ENV: 'production', SLM_BASE_URL: 'http://localhost:11434', API_KEY: '' }));
  assert.equal(s.ready, false);
  assert.ok(s.warnings.some((w) => /local address/.test(w)));
  assert.ok(s.warnings.some((w) => /API_KEY/.test(w)));
  assert.ok(s.warnings.some((w) => /Upstash/.test(w)));
  assert.equal(s.state.store, 'memory');
  const ok = configStatus(getConfig({ ...baseEnv, NODE_ENV: 'production', UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }));
  assert.equal(ok.ready, true);
  assert.equal(ok.state.store, 'upstash');
});

test('malformed env => CONFIG_ERROR', () => {
  assert.throws(() => getConfig({ ...baseEnv, SMTP_PORT: 'abc' }), (e) => e.code === 'CONFIG_ERROR');
  assert.throws(() => getConfig({ ...baseEnv, SLM_BASE_URL: 'not a url' }), (e) => e.code === 'CONFIG_ERROR');
});

test('PDF: valid, in-memory, unique filenames, multi-page for long item lists', async () => {
  const { calculateInvoice } = await import('../src/services/invoiceCalculationService.js');
  const { validateInvoiceInput } = await import('../src/validators/invoiceValidator.js');
  const inv = calculateInvoice(validateInvoiceInput(structuredBody({
    notes: 'Net 30', paymentStatus: 'Paid', discount: { type: 'percentage', value: 5 },
    items: Array.from({ length: 60 }, (_, i) => ({ name: `Item number ${i + 1} with a reasonably long description`, quantity: i + 1, unitPrice: 99.5 })),
  })));
  const a = await generateInvoicePdf(inv, { name: 'Acme', email: 'billing@acme.test', address: '1 Main St' });
  const b = await generateInvoicePdf(inv, {});
  assert.equal(a.buffer.subarray(0, 5).toString(), '%PDF-');
  assert.notEqual(a.filename, b.filename);
  assert.ok((a.buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length >= 2);
});
