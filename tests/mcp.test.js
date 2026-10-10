import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpRequest } from '../src/mcp/server.js';
import { TOOLS } from '../src/mcp/tools.js';
import { invoiceInputSchema } from '../src/validators/invoiceValidator.js';
import { generateInvoicePdf } from '../src/services/pdfService.js';
import { createHandler as mcpHandler } from '../api/mcp.js';
import { AppError } from '../src/utils/errors.js';
import { baseEnv, fakeDeps, makeConfig, mockReq, mockRes, newStore, structuredBody } from './helpers.js';

const config = makeConfig();
const MODERN = '2026-07-28';

// ---- builders ---------------------------------------------------------------------------------------
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const meta = (extra = {}) => ({
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
  ...extra,
});
const modernHeaders = (method, name) => ({
  'mcp-protocol-version': MODERN,
  'mcp-method': method,
  ...(name !== undefined ? { 'mcp-name': name } : {}),
});
const modernCall = (name, args, id = 1) => [
  rpc('tools/call', { name, arguments: args, _meta: meta() }, id),
  modernHeaders('tools/call', name),
];

function makeEnv(depOverrides) {
  const counter = { pdf: 0 };
  const { deps, calls } = fakeDeps({
    generatePdf: async (inv) => {
      counter.pdf++;
      return { buffer: Buffer.from('%PDF-1.4 fake ' + inv.invoiceNumber), filename: 'invoice-test.pdf' };
    },
    ...depOverrides,
  });
  if (!depOverrides?.generatePdf) Object.defineProperty(calls, 'pdf', { get: () => counter.pdf });
  const store = newStore();
  const call = (payload, headers = {}) => handleMcpRequest(payload, { config, store, deps, headers });
  const tool = async (name, args) => (await call(rpc('tools/call', { name, arguments: args }))).body.result;
  return { call, tool, calls, store };
}

// ---- Legacy era: initialize / tools/list --------------------------------------------------------------
test('legacy initialize echoes a supported version, declares tools, issues no session id', async () => {
  const { call } = makeEnv();
  for (const v of ['2025-03-26', '2025-06-18', '2025-11-25']) {
    const r = await call(rpc('initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 'c', version: '1' } }));
    assert.equal(r.status, 200);
    assert.equal(r.body.result.protocolVersion, v);
    assert.deepEqual(r.body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(r.body.result.serverInfo.name, 'invoice-agent');
    assert.equal(r.body.result.resultType, undefined);
    assert.equal(r.headers, undefined);
  }
  // unknown/future version: server answers with its latest legacy version
  assert.equal((await call(rpc('initialize', { protocolVersion: '2099-01-01' }))).body.result.protocolVersion, '2025-11-25');
  assert.equal((await call(rpc('initialize', {}))).body.error.code, -32602);
});

test('notifications are accepted with 202 and no body', async () => {
  const { call } = makeEnv();
  for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/whatever']) {
    const r = await call({ jsonrpc: '2.0', method });
    assert.deepEqual([r.status, r.body], [202, null]);
  }
});

test('ping works; tools/list returns the two tools deterministically with schemas and annotations', async () => {
  const { call } = makeEnv();
  assert.deepEqual((await call(rpc('ping'))).body.result, {});
  const a = (await call(rpc('tools/list'))).body.result;
  const b = (await call(rpc('tools/list', {}))).body.result;
  assert.deepEqual(a, b);
  assert.deepEqual(a.tools.map((t) => t.name), ['generate_invoice_pdf', 'send_invoice_email']);
  for (const t of a.tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.ok(t.description.length > 40 && t.title);
  }
  assert.equal(a.tools[0].annotations.readOnlyHint, true);
  assert.equal(a.tools[1].annotations.readOnlyHint, false);
  assert.equal(a.tools[1].annotations.destructiveHint, false);
  assert.ok(a.tools[1].inputSchema.properties.idempotencyKey);
  assert.equal(a.tools[0].inputSchema.properties.idempotencyKey, undefined);
  assert.equal(a.resultType, undefined);
});

test('tool input schemas cover every field the Zod validator accepts', () => {
  const zodKeys = Object.keys(invoiceInputSchema.shape).sort();
  for (const t of TOOLS) {
    const props = Object.keys(t.inputSchema.properties);
    for (const k of zodKeys) assert.ok(props.includes(k), `${t.name} is missing "${k}"`);
    assert.ok(props.includes('input'));
  }
});

// ---- generate_invoice_pdf ------------------------------------------------------------------------------
test('generate_invoice_pdf: returns the PDF resource + structured summary, sends NO email', async () => {
  const { tool, calls } = makeEnv();
  const r = await tool('generate_invoice_pdf', structuredBody({ invoiceNumber: 'INV-1001' }));
  assert.equal(r.isError, false);
  assert.equal(r.content[0].type, 'text');
  const res = r.content[1];
  assert.equal(res.type, 'resource');
  assert.equal(res.resource.mimeType, 'application/pdf');
  assert.equal(res.resource.uri, 'invoice://INV-1001/invoice-test.pdf');
  assert.match(Buffer.from(res.resource.blob, 'base64').toString(), /^%PDF-/);
  assert.equal(r.structuredContent.grandTotal, 119180);
  assert.equal(r.structuredContent.emailSubmitted, false);
  assert.equal(r.structuredContent.pdfGenerated, true);
  assert.equal(r.structuredContent.email, undefined);
  assert.deepEqual([calls.extract, calls.pdf, calls.email], [0, 1, 0]);
});

test('generate_invoice_pdf with plain text uses the SLM extraction path', async () => {
  const { tool, calls } = makeEnv();
  const r = await tool('generate_invoice_pdf', { input: 'Invoice John, john@example.com, 2 laptops at 50000 INR, 18% tax' });
  assert.equal(r.isError, false);
  assert.equal(calls.extract, 1);
  assert.equal(calls.email, 0);
});

test('generate_invoice_pdf works with the real PDF renderer', async () => {
  const { call } = makeEnv({ generatePdf: generateInvoicePdf });
  const r = (await call(rpc('tools/call', { name: 'generate_invoice_pdf', arguments: structuredBody() }))).body.result;
  const pdf = Buffer.from(r.content[1].resource.blob, 'base64');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(r.structuredContent.sizeBytes, pdf.length);
});

// ---- send_invoice_email -------------------------------------------------------------------------------------
test('send_invoice_email: generates the PDF and submits the email once', async () => {
  const { tool, calls } = makeEnv();
  const r = await tool('send_invoice_email', structuredBody());
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.emailSubmitted, true);
  assert.equal(r.structuredContent.pdfGenerated, true);
  assert.match(r.content[0].text, /does not confirm inbox delivery/);
  assert.equal(r.content.length, 1); // no PDF payload in the email tool
  assert.deepEqual([calls.pdf, calls.email], [1, 1]);
});

test('send_invoice_email: recipient comes only from the validated invoice email', async () => {
  let sent;
  const { tool } = makeEnv({ sendEmail: async (inv) => { sent = inv.email; return { submitted: true }; } });
  await tool('send_invoice_email', structuredBody({ email: 'customer@example.com' }));
  assert.equal(sent, 'customer@example.com');
  const bad = await tool('send_invoice_email', structuredBody({ bcc: 'evil@x.com' }));
  assert.equal(bad.isError, true); // unknown fields are rejected, not forwarded
});

test('send_invoice_email idempotencyKey: repeat returns the first result and sends one email', async () => {
  const { tool, calls } = makeEnv();
  const args = structuredBody({ idempotencyKey: 'mcp-key-0001' });
  const a = await tool('send_invoice_email', args);
  const b = await tool('send_invoice_email', args);
  assert.equal(calls.email, 1);
  assert.equal(b.structuredContent.idempotentReplay, true);
  assert.equal(b.structuredContent.invoiceNumber, a.structuredContent.invoiceNumber);
  assert.match(b.content[0].text, /no second email/);
});

test('send_invoice_email: concurrent duplicate => DUPLICATE_IN_PROGRESS; failed attempt releases the key', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { deps, calls } = fakeDeps({ sendEmail: async () => { calls.email++; await gate; return { submitted: true }; } });
  const store = newStore();
  const run = (args) => handleMcpRequest(rpc('tools/call', { name: 'send_invoice_email', arguments: args }), { config, store, deps, headers: {} });
  const first = run(structuredBody({ idempotencyKey: 'mcp-key-0002' }));
  await new Promise((r) => setTimeout(r, 20));
  const dup = (await run(structuredBody({ idempotencyKey: 'mcp-key-0002' }))).body.result;
  assert.equal(dup.isError, true);
  assert.equal(dup.structuredContent.error, 'DUPLICATE_IN_PROGRESS');
  release();
  await first;
  assert.equal(calls.email, 1);

  // failure releases the key
  let fail = true;
  const f = makeEnv({ sendEmail: async () => { if (fail) throw new AppError('EMAIL_FAILED', 'smtp said no', 502); return { submitted: true }; } });
  const args = structuredBody({ idempotencyKey: 'mcp-key-0003' });
  assert.equal((await f.tool('send_invoice_email', args)).isError, true);
  fail = false;
  assert.equal((await f.tool('send_invoice_email', args)).isError, false);
});

test('invalid idempotencyKey => tool error', async () => {
  const { tool } = makeEnv();
  const r = await tool('send_invoice_email', structuredBody({ idempotencyKey: 'short' }));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /idempotencyKey/);
});

// ---- Tool execution errors (isError) ---------------------------------------------------------------------------
for (const name of ['generate_invoice_pdf', 'send_invoice_email']) {
  test(`${name}: validation problems => isError result with actionable details; nothing generated or sent`, async () => {
    const { tool, calls } = makeEnv();
    for (const args of [structuredBody({ email: 'nope' }), structuredBody({ items: [] }), structuredBody({ currency: undefined }), { input: '   ' }]) {
      const r = await tool(name, args);
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent.error, 'VALIDATION_ERROR');
      assert.equal(r.structuredContent.retryable, false);
      assert.match(r.content[0].text, /call the tool again|Fix the listed fields/);
    }
    assert.deepEqual([calls.pdf, calls.email], [0, 0]);
  });

  test(`${name}: mismatching supplied totals => FINANCIAL_DISCREPANCY listing the numbers`, async () => {
    const { tool, calls } = makeEnv();
    const r = await tool(name, structuredBody({ grandTotal: 1 }));
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error, 'FINANCIAL_DISCREPANCY');
    assert.match(r.content[0].text, /grandTotal: supplied 1, calculated 119180/);
    assert.equal(calls.pdf + calls.email, 0);
  });
}

for (const [label, dep, tool, code, retryable] of [
  ['SLM timeout', { extract: async () => { throw new AppError('SLM_TIMEOUT', 'The language model did not respond in time.', 504); } }, 'generate_invoice_pdf', 'SLM_TIMEOUT', true],
  ['PDF failure', { generatePdf: async () => { throw new AppError('PDF_GENERATION_FAILED', 'The invoice PDF could not be generated.', 500); } }, 'generate_invoice_pdf', 'PDF_GENERATION_FAILED', false],
  ['SMTP failure', { sendEmail: async () => { throw new AppError('EMAIL_FAILED', 'The SMTP server did not accept the message (EAUTH).', 502); } }, 'send_invoice_email', 'EMAIL_FAILED', true],
  ['SMTP not configured', { sendEmail: async () => { throw new AppError('CONFIG_ERROR', 'SMTP is not configured.', 503); } }, 'send_invoice_email', 'CONFIG_ERROR', false],
]) {
  test(`${label} => isError result {error: ${code}, retryable: ${retryable}}`, async () => {
    const { tool: run } = makeEnv(dep);
    const args = dep.extract ? { input: 'invoice text' } : structuredBody();
    const r = await run(tool, args);
    assert.equal(r.isError, true);
    assert.deepEqual([r.structuredContent.error, r.structuredContent.retryable], [code, retryable]);
  });
}

test('unexpected exceptions => generic tool error, nothing leaked', async () => {
  const { call } = makeEnv({ sendEmail: async () => { throw new Error('boom smtp-secret /var/task/x.js'); } });
  const { status, body } = await call(rpc('tools/call', { name: 'send_invoice_email', arguments: structuredBody() }));
  assert.equal(status, 200);
  assert.equal(body.result.isError, true);
  assert.equal(body.result.structuredContent.error, 'INTERNAL_ERROR');
  assert.doesNotMatch(JSON.stringify(body), /smtp-secret|\/var\/task|boom/);
});

test('oversized PDF is refused instead of returning a huge response', async () => {
  const { tool } = makeEnv({ generatePdf: async () => ({ buffer: Buffer.alloc(3_100_000), filename: 'big.pdf' }) });
  const r = await tool('generate_invoice_pdf', structuredBody());
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /too large/);
});

// ---- Protocol errors ----------------------------------------------------------------------------------------------
test('protocol errors: unknown tool / missing name / bad arguments => -32602; unknown method => -32601', async () => {
  const { call } = makeEnv();
  assert.equal((await call(rpc('tools/call', { name: 'delete_everything', arguments: {} }))).body.error.code, -32602);
  assert.equal((await call(rpc('tools/call', { arguments: {} }))).body.error.code, -32602);
  assert.equal((await call(rpc('tools/call', { name: 'generate_invoice_pdf', arguments: 'x' }))).body.error.code, -32602);
  assert.equal((await call(rpc('tools/call', { name: 'generate_invoice_pdf', arguments: [1] }))).body.error.code, -32602);
  const m = await call(rpc('resources/list', {}));
  assert.deepEqual([m.status, m.body.error.code], [200, -32601]);
  assert.equal((await call(rpc('constructor', {}))).body.error.code, -32601);
  assert.equal((await call(rpc('tools/list', 'nope'))).body.error.code, -32602);
});

test('envelope errors => -32600 with HTTP 400 (batch, non-object, bad jsonrpc/method/id)', async () => {
  const { call } = makeEnv();
  for (const p of [[], 'x', null, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 5 }, { jsonrpc: '2.0', id: {}, method: 'ping' }, { jsonrpc: '2.0', id: null, method: 'ping' }]) {
    const r = await call(p);
    assert.equal(r.status, 400, JSON.stringify(p));
    assert.equal(r.body.error.code, -32600);
    assert.equal(r.body.id, null);
  }
});

test('legacy: MCP-Protocol-Version header accepted when supported, rejected (400, -32022) when unknown', async () => {
  const { call } = makeEnv();
  assert.equal((await call(rpc('tools/list'), { 'mcp-protocol-version': '2025-06-18' })).status, 200);
  assert.equal((await call(rpc('tools/list'), {})).status, 200);
  const bad = await call(rpc('tools/list'), { 'mcp-protocol-version': '1999-01-01' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, -32022);
  assert.ok(bad.body.error.data.supported.includes('2026-07-28'));
});

// ---- Modern era (2026-07-28) ----------------------------------------------------------------------------------------
test('modern server/discover: versions, capabilities, serverInfo in _meta, resultType', async () => {
  const { call } = makeEnv();
  const r = await call(rpc('server/discover', { _meta: meta() }), modernHeaders('server/discover'));
  assert.equal(r.status, 200);
  const res = r.body.result;
  assert.equal(res.resultType, 'complete');
  assert.deepEqual(res.supportedVersions, ['2026-07-28', '2025-03-26', '2025-06-18', '2025-11-25']);
  assert.deepEqual(res.capabilities, { tools: { listChanged: false } });
  assert.equal(res._meta['io.modelcontextprotocol/serverInfo'].name, 'invoice-agent');
  assert.ok(res.instructions);
});

test('modern tools/list and tools/call carry resultType and serverInfo', async () => {
  const { call } = makeEnv();
  const list = (await call(rpc('tools/list', { _meta: meta() }), modernHeaders('tools/list'))).body.result;
  assert.equal(list.resultType, 'complete');
  assert.equal(list.tools.length, 2);
  assert.equal(list.ttlMs, 300000);

  const [body, headers] = modernCall('generate_invoice_pdf', structuredBody());
  const res = (await call(body, headers)).body.result;
  assert.equal(res.resultType, 'complete');
  assert.equal(res.isError, false);
  assert.equal(res.content[1].resource.mimeType, 'application/pdf');
  assert.ok(res._meta['io.modelcontextprotocol/serverInfo']);
});

test('modern header validation: missing/mismatched headers => 400 / -32020', async () => {
  const { call } = makeEnv();
  const [body] = modernCall('send_invoice_email', structuredBody());
  const cases = [
    {}, // no headers at all
    { 'mcp-protocol-version': MODERN, 'mcp-name': 'send_invoice_email' }, // no Mcp-Method
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call' }, // no Mcp-Name
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list', 'mcp-name': 'send_invoice_email' }, // method mismatch
    { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'generate_invoice_pdf' }, // name mismatch
    { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/call', 'mcp-name': 'send_invoice_email' }, // version mismatch
  ];
  for (const headers of cases) {
    const r = await call(body, headers);
    assert.equal(r.status, 400, JSON.stringify(headers));
    assert.equal(r.body.error.code, -32020, JSON.stringify(headers));
  }
});

test('modern Mcp-Name may be base64-encoded', async () => {
  const { call } = makeEnv();
  const [body, headers] = modernCall('generate_invoice_pdf', structuredBody());
  headers['mcp-name'] = `=?base64?${Buffer.from('generate_invoice_pdf').toString('base64')}?=`;
  assert.equal((await call(body, headers)).status, 200);
});

test('modern: missing _meta fields => 400 / -32602; unsupported version => 400 / -32022 with supported list', async () => {
  const { call } = makeEnv();
  const h = modernHeaders('tools/list');
  // header says modern but _meta absent
  let r = await call(rpc('tools/list', {}), h);
  assert.deepEqual([r.status, r.body.error.code], [400, -32602]);
  // _meta without capabilities
  r = await call(rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } }), h);
  assert.deepEqual([r.status, r.body.error.code], [400, -32602]);
  // unknown version in _meta
  r = await call(rpc('tools/list', { _meta: meta({ 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }) }), { ...h, 'mcp-protocol-version': '2099-01-01' });
  assert.deepEqual([r.status, r.body.error.code], [400, -32022]);
  assert.equal(r.body.error.data.requested, '2099-01-01');
  assert.ok(r.body.error.data.supported.includes('2026-07-28'));
});

test('modern unknown method => HTTP 404 with -32601', async () => {
  const { call } = makeEnv();
  const r = await call(rpc('prompts/list', { _meta: meta() }), modernHeaders('prompts/list'));
  assert.deepEqual([r.status, r.body.error.code], [404, -32601]);
});

test('modern tool execution errors are still isError results (not protocol errors)', async () => {
  const { call } = makeEnv();
  const [body, headers] = modernCall('send_invoice_email', structuredBody({ email: 'bad' }));
  const r = await call(body, headers);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.isError, true);
  assert.equal(r.body.result.resultType, 'complete');
});

// ---- HTTP transport (api/mcp.js) -----------------------------------------------------------------------------------------
const auth = { 'x-api-key': 'test-api-key' };
const mk = (env = {}) => {
  const { deps, calls } = fakeDeps({ generatePdf: async () => ({ buffer: Buffer.from('%PDF-x'), filename: 'i.pdf' }) });
  return { handler: mcpHandler({ deps, store: newStore(), env: { ...baseEnv, ...env } }), calls };
};
const post = async (body, { headers = auth, env, handler } = {}) => {
  const m = handler ? { handler } : mk(env);
  const res = mockRes();
  await m.handler(mockReq({ headers, body }), res);
  return { res, calls: m.calls };
};

test('HTTP: initialize + tools/call round trip; Mcp-Session-Id is ignored and never issued', async () => {
  const init = await post(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} }), { headers: { ...auth, 'mcp-session-id': 'abc' } });
  assert.equal(init.res.statusCode, 200);
  assert.equal(init.res.json.result.serverInfo.name, 'invoice-agent');
  assert.equal(init.res.headers['mcp-session-id'], undefined);

  const { res, calls } = await post(rpc('tools/call', { name: 'send_invoice_email', arguments: structuredBody() }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.result.structuredContent.emailSubmitted, true);
  assert.equal(calls.email, 1);
});

test('HTTP: notification => 202 with empty body', async () => {
  const { res } = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body, '');
});

test('HTTP auth: x-api-key and Authorization: Bearer both work; missing/wrong => 401 with no tool executed', async () => {
  assert.equal((await post(rpc('ping'), { headers: { authorization: 'Bearer test-api-key' } })).res.statusCode, 200);
  assert.equal((await post(rpc('ping'), { headers: auth })).res.statusCode, 200);
  for (const headers of [{}, { 'x-api-key': 'wrong' }, { authorization: 'Bearer wrong' }, { authorization: 'Basic dGVzdA==' }]) {
    const { res, calls } = await post(rpc('tools/call', { name: 'send_invoice_email', arguments: structuredBody() }), { headers });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.error.code, -31401);
    assert.match(res.headers['www-authenticate'], /Bearer/);
    assert.equal(calls.email, 0);
  }
});

test('HTTP: production without API_KEY fails closed (503)', async () => {
  const { res } = await post(rpc('ping'), { headers: {}, env: { NODE_ENV: 'production', API_KEY: '' } });
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(res.body, /smtp-secret|slm-secret/);
});

test('HTTP: GET and DELETE => 405 (no SSE stream, no sessions)', async () => {
  const { handler } = mk();
  for (const method of ['GET', 'DELETE']) {
    const res = mockRes();
    await handler(mockReq({ method, headers: auth }), res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST');
  }
});

test('HTTP Origin validation: foreign browser origin => 403; same-host and allow-listed origins pass; no Origin passes', async () => {
  const withOrigin = (origin, env) => post(rpc('ping'), { headers: { ...auth, origin, host: 'invoice.example.com' }, env });
  assert.equal((await withOrigin('https://evil.example.org')).res.statusCode, 403);
  assert.equal((await withOrigin('https://invoice.example.com')).res.statusCode, 200);
  assert.equal((await withOrigin('https://app.trusted.io', { MCP_ALLOWED_ORIGINS: 'https://app.trusted.io, https://x.io' })).res.statusCode, 200);
  assert.equal((await withOrigin('not a url')).res.statusCode, 403);
  assert.equal((await post(rpc('ping'))).res.statusCode, 200);
});

test('HTTP: invalid JSON => 400 / -32700; wrong content type => 415; oversized => 413; rate limit => 429', async () => {
  const { handler } = mk({ MAX_BODY_BYTES: '1024', RATE_LIMIT_PER_MINUTE: '4' });
  const send = async (req) => { const res = mockRes(); await handler(req, res); return res; };

  let res = await send(mockReq({ headers: auth, body: '{nope' }));
  assert.deepEqual([res.statusCode, res.json.error.code], [400, -32700]);

  res = await send(mockReq({ headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' }));
  assert.equal(res.statusCode, 415);

  res = await send(mockReq({ headers: auth, body: { pad: 'x'.repeat(3000) } }));
  assert.deepEqual([res.statusCode, res.json.error.code], [413, -31413]);

  res = await send(mockReq({ headers: auth, body: rpc('ping') })); // 4th request in the window
  assert.equal(res.statusCode, 200);
  res = await send(mockReq({ headers: auth, body: rpc('ping') }));
  assert.deepEqual([res.statusCode, res.json.error.code, res.headers['retry-after']], [429, -31429, '60']);
});

test('HTTP: modern-era request over the handler (header validation uses real request headers)', async () => {
  const [body, headers] = modernCall('generate_invoice_pdf', structuredBody());
  const { res } = await post(body, { headers: { ...auth, ...headers } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.result.resultType, 'complete');
  const bad = await post(body, { headers: { ...auth, 'mcp-protocol-version': MODERN } });
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.res.json.error.code, -32020);
});
