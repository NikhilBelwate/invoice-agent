import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleA2ARequest } from '../src/a2a/server.js';
import { buildAgentCard, resolveBaseUrl } from '../src/a2a/agentCard.js';
import { createHandler as a2aHandler } from '../api/a2a.js';
import { createHandler as cardHandler } from '../api/agent-card.js';
import { AppError } from '../src/utils/errors.js';
import { baseEnv, fakeDeps, makeConfig, mockReq, mockRes, newStore, structuredBody } from './helpers.js';

const config = makeConfig();
let n = 0;
const mid = () => `msg-${++n}-${Math.random().toString(36).slice(2, 8)}`;

// ---- request builders ---------------------------------------------------------------------------
const v1Msg = (parts, extra = {}) => ({ messageId: mid(), role: 'ROLE_USER', parts, ...extra });
const v03Msg = (parts, extra = {}) => ({ kind: 'message', messageId: mid(), role: 'user', parts, ...extra });
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const dataPart = (d) => ({ data: d });

function makeEnv(depOverrides) {
  const { deps, calls } = fakeDeps(depOverrides);
  const store = newStore();
  const call = (payload, extra = {}) => handleA2ARequest(payload, { config, store, deps, ...extra });
  return { call, calls, store };
}

// ---- Agent Card -----------------------------------------------------------------------------------
test('Agent Card has required 1.0 + 0.3 fields, honest capabilities and no secrets', () => {
  const card = buildAgentCard({ baseUrl: 'https://agent.example.com', config });
  for (const k of ['name', 'description', 'version', 'supportedInterfaces', 'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills']) assert.ok(card[k], k);
  assert.equal(card.url, 'https://agent.example.com/api/a2a');
  assert.deepEqual(card.supportedInterfaces.map((i) => i.protocolVersion), ['1.0', '0.3']);
  assert.equal(card.preferredTransport, 'JSONRPC');
  assert.equal(card.capabilities.streaming, false);
  assert.equal(card.capabilities.pushNotifications, false);
  assert.ok(card.skills[0].id && card.skills[0].tags.length && card.skills[0].description);
  assert.equal(card.securitySchemes.apiKey.name, 'x-api-key');
  const json = JSON.stringify(card);
  for (const secret of ['slm-secret', 'smtp-secret', 'test-api-key', 'smtp-user', 'slm.example.com']) assert.ok(!json.includes(secret));
});

test('Agent Card endpoint: public, cacheable, base URL from PUBLIC_BASE_URL or forwarded host; GET only', async () => {
  const h = cardHandler({ env: baseEnv });
  const res = mockRes();
  await h(mockReq({ method: 'GET', headers: { 'x-forwarded-host': 'agent.example.com' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.url, 'https://agent.example.com/api/a2a');
  assert.match(res.headers['cache-control'], /public/);

  const res2 = mockRes();
  await cardHandler({ env: { ...baseEnv, PUBLIC_BASE_URL: 'https://fixed.example.org/' } })(mockReq({ method: 'GET', headers: { host: 'evil.test' } }), res2);
  assert.equal(res2.json.url, 'https://fixed.example.org/api/a2a');

  const res3 = mockRes();
  await h(mockReq({ method: 'POST' }), res3);
  assert.equal(res3.statusCode, 405);
  assert.equal(resolveBaseUrl({ headers: { host: 'bad host!' } }, config), 'http://localhost');
});

// ---- SendMessage: 1.0 dialect ---------------------------------------------------------------------
test('1.0 SendMessage with a data part => completed task, TASK_STATE_* enums, no `kind`, SLM not called', async () => {
  const { call, calls } = makeEnv();
  const { status, body } = await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]) }));
  assert.equal(status, 200);
  const task = body.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.kind, undefined);
  assert.equal(task.artifacts[0].parts[0].data.grandTotal, 119180);
  assert.equal(task.artifacts[0].parts[0].mediaType, 'application/json');
  assert.equal(task.status.message.role, 'ROLE_AGENT');
  assert.match(task.status.message.parts[0].text, /SMTP/);
  assert.ok(task.id && task.contextId);
  assert.deepEqual([calls.extract, calls.pdf, calls.email], [0, 1, 1]);
});

test('1.0 SendMessage with a text part uses the SLM extraction path', async () => {
  const { call, calls } = makeEnv();
  const { body } = await call(rpc('SendMessage', { message: v1Msg([{ text: 'Invoice John, john@example.com, 2 laptops at 50000 INR, 18% tax' }]) }));
  assert.equal(body.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(calls.extract, 1);
});

// ---- message/send: 0.3 dialect --------------------------------------------------------------------
test('0.3 message/send => Task with kind fields and lowercase states', async () => {
  const { call } = makeEnv();
  const { body } = await call(rpc('message/send', { message: v03Msg([{ kind: 'data', data: structuredBody() }]) }));
  const task = body.result;
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  assert.equal(task.status.message.kind, 'message');
  assert.equal(task.status.message.role, 'agent');
  assert.equal(task.artifacts[0].parts[0].kind, 'data');
});

// ---- input-required flow --------------------------------------------------------------------------
test('missing email => input-required with an explanation; follow-up on same task completes it', async () => {
  const { call, calls } = makeEnv();
  const first = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody({ email: undefined }))]) }))).body.result.task;
  assert.equal(first.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(first.status.message.parts[0].text, /email/i);
  assert.equal(first.status.message.parts[1].data.error, 'VALIDATION_ERROR');
  assert.equal(calls.pdf + calls.email, 0);

  const second = (await call(rpc('SendMessage', {
    message: v1Msg([dataPart({ email: 'john@example.com' })], { taskId: first.id, contextId: first.contextId }),
  }))).body.result.task;
  assert.equal(second.id, first.id);
  assert.equal(second.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(calls.email, 1);
});

test('text follow-ups are concatenated with the earlier text', async () => {
  const seen = [];
  const { call } = makeEnv({
    extract: async (text) => {
      seen.push(text);
      if (!text.includes('@')) throw new AppError('VALIDATION_ERROR', 'A valid customer email and at least one valid product are required.', 400, [{ field: 'email', problem: 'Required' }]);
      return structuredBody();
    },
  });
  const t1 = (await call(rpc('message/send', { message: v03Msg([{ kind: 'text', text: '2 laptops at 50000 CAD' }]) }))).body.result;
  assert.equal(t1.status.state, 'input-required');
  const t2 = (await call(rpc('message/send', { message: v03Msg([{ kind: 'text', text: 'email is a@b.com' }], { taskId: t1.id }) }))).body.result;
  assert.equal(t2.status.state, 'completed');
  assert.equal(seen[1], '2 laptops at 50000 CAD\nemail is a@b.com');
});

test('financial discrepancy => input-required listing the mismatch', async () => {
  const { call, calls } = makeEnv();
  const t = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody({ grandTotal: 1 }))]) }))).body.result.task;
  assert.equal(t.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(t.status.message.parts[0].text, /grandTotal: supplied 1, calculated 119180/);
  assert.equal(calls.email, 0);
});

test('follow-up to a completed task is rejected (UnsupportedOperation); unknown task => TaskNotFound; context mismatch => InvalidParams', async () => {
  const { call } = makeEnv();
  const done = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]) }))).body.result.task;
  const again = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())], { taskId: done.id }) }))).body;
  assert.equal(again.error.code, -32004);
  const missing = (await call(rpc('SendMessage', { message: v1Msg([dataPart({})], { taskId: 'nope-123' }) }))).body;
  assert.equal(missing.error.code, -32001);
  const bad = (await call(rpc('SendMessage', { message: v1Msg([dataPart({})], { taskId: done.id, contextId: 'other' }) }))).body;
  assert.equal(bad.error.code, -32602);
});

// ---- failures become `failed` tasks ---------------------------------------------------------------
for (const [name, dep, code, retryable] of [
  ['SLM timeout', { extract: async () => { throw new AppError('SLM_TIMEOUT', 'The language model did not respond in time.', 504); } }, 'SLM_TIMEOUT', true],
  ['SMTP failure', { sendEmail: async () => { throw new AppError('EMAIL_FAILED', 'The SMTP server did not accept the message (EAUTH).', 502); } }, 'EMAIL_FAILED', true],
  ['PDF failure', { generatePdf: async () => { throw new AppError('PDF_GENERATION_FAILED', 'The invoice PDF could not be generated.', 500); } }, 'PDF_GENERATION_FAILED', false],
  ['config error', { sendEmail: async () => { throw new AppError('CONFIG_ERROR', 'SMTP is not configured.', 503); } }, 'CONFIG_ERROR', false],
]) {
  test(`${name} => failed task with { error: ${code}, retryable: ${retryable} }`, async () => {
    const { call } = makeEnv(dep);
    const body = dep.extract ? { text: 'invoice text' } : dataPart(structuredBody());
    const t = (await call(rpc('SendMessage', { message: v1Msg([body]) }))).body.result.task;
    assert.equal(t.status.state, 'TASK_STATE_FAILED');
    assert.deepEqual(t.status.message.parts[1].data, { error: code, retryable });
  });
}

test('unexpected exceptions => failed task with a generic message (no leak), not a protocol error', async () => {
  const { call } = makeEnv({ sendEmail: async () => { throw new Error('boom smtp-secret /var/task/x.js'); } });
  const { status, body } = await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]) }));
  assert.equal(status, 200);
  assert.equal(body.result.task.status.state, 'TASK_STATE_FAILED');
  assert.doesNotMatch(JSON.stringify(body), /smtp-secret|\/var\/task|boom/);
  assert.equal(body.result.task.status.message.parts[1].data.error, 'INTERNAL_ERROR');
});

// ---- idempotency by messageId ---------------------------------------------------------------------
test('same messageId delivered twice => one email, same task returned', async () => {
  const { call, calls } = makeEnv();
  const message = v1Msg([dataPart(structuredBody())]);
  const a = (await call(rpc('SendMessage', { message }))).body.result.task;
  const b = (await call(rpc('SendMessage', { message }, 2))).body.result.task;
  assert.equal(calls.email, 1);
  assert.equal(b.id, a.id);
});

test('failed run releases the messageId so the same message can be retried', async () => {
  let fail = true;
  const { call, calls } = makeEnv({ sendEmail: async () => { if (fail) throw new AppError('EMAIL_FAILED', 'x', 502); calls.email++; return { submitted: true }; } });
  const message = v1Msg([dataPart(structuredBody())]);
  assert.equal((await call(rpc('SendMessage', { message }))).body.result.task.status.state, 'TASK_STATE_FAILED');
  fail = false;
  assert.equal((await call(rpc('SendMessage', { message }))).body.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(calls.email, 1);
});

// ---- GetTask / CancelTask -------------------------------------------------------------------------
test('GetTask / tasks/get in both dialects, with historyLength', async () => {
  const { call } = makeEnv();
  const t = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]) }))).body.result.task;
  const g1 = (await call(rpc('GetTask', { id: t.id, historyLength: 5 }))).body.result;
  assert.equal(g1.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(g1.history.length, 2);
  assert.equal(g1.history[0].role, 'ROLE_USER');
  const g03 = (await call(rpc('tasks/get', { id: t.id }))).body.result;
  assert.equal(g03.kind, 'task');
  assert.equal(g03.status.state, 'completed');
  assert.equal(g03.history, undefined);
  assert.equal((await call(rpc('GetTask', { id: 'does-not-exist' }))).body.error.code, -32001);
  assert.equal((await call(rpc('GetTask', {}))).body.error.code, -32602);
  assert.equal((await call(rpc('GetTask', { id: t.id, historyLength: -1 }))).body.error.code, -32602);
});

test('CancelTask: input-required => canceled (idempotent); completed => TaskNotCancelable; unknown => TaskNotFound', async () => {
  const { call, calls } = makeEnv();
  const waiting = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody({ email: undefined }))]) }))).body.result.task;
  const c1 = (await call(rpc('CancelTask', { id: waiting.id }))).body.result;
  assert.equal(c1.status.state, 'TASK_STATE_CANCELED');
  assert.equal((await call(rpc('CancelTask', { id: waiting.id }))).body.result.status.state, 'TASK_STATE_CANCELED');
  // canceled task cannot be resumed
  assert.equal((await call(rpc('SendMessage', { message: v1Msg([dataPart({ email: 'a@b.com' })], { taskId: waiting.id }) }))).body.error.code, -32004);
  assert.equal(calls.email, 0);

  const done = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]) }))).body.result.task;
  assert.equal((await call(rpc('tasks/cancel', { id: done.id }))).body.error.code, -32002);
  assert.equal((await call(rpc('CancelTask', { id: 'zzz-unknown' }))).body.error.code, -32001);
});

test('stale "working" task is closed out as failed with an outcome-unknown message', async () => {
  const { call, store } = makeEnv();
  const { createTaskStore } = await import('../src/a2a/taskStore.js');
  const ts = createTaskStore(store);
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  await ts.saveTask({ id: 'stuck-1', contextId: 'c1', status: { state: 'working', timestamp: old }, history: [] });
  const t = (await call(rpc('GetTask', { id: 'stuck-1' }))).body.result;
  assert.equal(t.status.state, 'TASK_STATE_FAILED');
  assert.match(t.status.message.parts[0].text, /unknown/i);
  assert.equal(t.status.message.parts[1].data.error, 'PROCESSING_INTERRUPTED');
});

// ---- Protocol-level errors ------------------------------------------------------------------------
test('envelope errors: batch, non-object, bad jsonrpc/id/method => -32600 (HTTP 400, id echoed when valid)', async () => {
  const { call } = makeEnv();
  for (const p of [[], 'x', null, { jsonrpc: '1.0', id: 1, method: 'GetTask' }, { jsonrpc: '2.0', method: 'GetTask' }, { jsonrpc: '2.0', id: {}, method: 'GetTask' }, { jsonrpc: '2.0', id: 1, method: 5 }]) {
    const r = await call(p);
    assert.equal(r.status, 400, JSON.stringify(p));
    assert.equal(r.body.error.code, -32600);
    const validId = p && typeof p === 'object' && !Array.isArray(p) && (typeof p.id === 'string' || Number.isInteger(p.id));
    assert.equal(r.body.id, validId ? p.id : null);
  }
  assert.equal((await call({ jsonrpc: '2.0', id: 'abc', method: 5 })).body.id, 'abc');
});

test('unknown method => -32601; params not an object => -32602; prototype-name methods are not resolvable', async () => {
  const { call } = makeEnv();
  assert.equal((await call(rpc('DoSomething', {}))).body.error.code, -32601);
  assert.equal((await call(rpc('constructor', {}))).body.error.code, -32601);
  assert.equal((await call(rpc('__proto__', {}))).body.error.code, -32601);
  assert.equal((await call(rpc('SendMessage', 'nope'))).body.error.code, -32602);
});

test('invalid messages => -32602 (missing/blank messageId, wrong role, no parts, bad part, oversized text)', async () => {
  const { call } = makeEnv();
  const bad = [
    {},
    v1Msg([{ text: 'x' }], { messageId: '' }),
    v1Msg([{ text: 'x' }], { role: 'ROLE_AGENT' }),
    v1Msg([]),
    v1Msg([{ foo: 1 }]),
    v1Msg([{ data: 'string-not-object' }]),
    v1Msg([{ text: 'x'.repeat(4001) }]),
    v1Msg([{ text: 'x' }], { taskId: 'bad id with spaces' }),
  ];
  for (const message of bad) {
    const r = (await call(rpc('SendMessage', { message }))).body;
    assert.equal(r.error?.code, -32602, JSON.stringify(message).slice(0, 80));
  }
});

test('file parts => ContentTypeNotSupported (-32005); unsupported acceptedOutputModes => -32005', async () => {
  const { call } = makeEnv();
  const f1 = (await call(rpc('SendMessage', { message: v1Msg([{ raw: 'AAAA', mediaType: 'application/pdf' }]) }))).body;
  const f03 = (await call(rpc('message/send', { message: v03Msg([{ kind: 'file', file: { bytes: 'AAAA' } }]) }))).body;
  assert.equal(f1.error.code, -32005);
  assert.equal(f03.error.code, -32005);
  const modes = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]), configuration: { acceptedOutputModes: ['image/png'] } }))).body;
  assert.equal(modes.error.code, -32005);
  const ok = (await call(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]), configuration: { acceptedOutputModes: ['image/png', 'application/json'] } }))).body;
  assert.ok(ok.result.task);
});

test('A2A-Version: 0.3 and 1.0 accepted; other versions => VersionNotSupported (-32009)', async () => {
  const { call } = makeEnv();
  for (const version of [undefined, '', '1.0', '0.3', '1.0.0', '0.3.1']) {
    const r = await call(rpc('GetTask', { id: 'nothing-here' }), { version });
    assert.equal(r.body.error.code, -32001, `version=${version}`); // got past version check
  }
  for (const version of ['2.0', '0.2', 'abc', '1']) {
    assert.equal((await call(rpc('GetTask', { id: 'x' }), { version })).body.error.code, -32009, `version=${version}`);
  }
});

test('declared-unsupported capabilities return the specific A2A errors', async () => {
  const { call } = makeEnv();
  const code = async (method) => (await call(rpc(method, { id: 'x' }))).body.error.code;
  assert.equal(await code('SendStreamingMessage'), -32004);
  assert.equal(await code('message/stream'), -32004);
  assert.equal(await code('SubscribeToTask'), -32004);
  assert.equal(await code('tasks/resubscribe'), -32004);
  assert.equal(await code('ListTasks'), -32004);
  assert.equal(await code('CreateTaskPushNotificationConfig'), -32003);
  assert.equal(await code('tasks/pushNotificationConfig/set'), -32003);
  assert.equal(await code('GetExtendedAgentCard'), -32007);
  assert.equal(await code('agent/getAuthenticatedExtendedCard'), -32007);
});

test('state store outage => retryable JSON-RPC internal error, nothing sent', async () => {
  const down = {
    get: async () => { throw new AppError('STATE_STORE_UNAVAILABLE', 'down', 503); },
    set: async () => { throw new AppError('STATE_STORE_UNAVAILABLE', 'down', 503); },
    setNx: async () => { throw new AppError('STATE_STORE_UNAVAILABLE', 'down', 503); },
    del: async () => {},
  };
  const { deps, calls } = fakeDeps();
  const r = await handleA2ARequest(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]) }), { config, store: down, deps });
  assert.equal(r.body.error.code, -32603);
  assert.equal(r.body.error.data.retryable, true);
  assert.equal(calls.email, 0);
});

// ---- HTTP transport (api/a2a.js) --------------------------------------------------------------------
const auth = { 'x-api-key': 'test-api-key' };
const post = async (body, { headers = auth, env } = {}) => {
  const { deps, calls } = fakeDeps();
  const h = a2aHandler({ deps, store: newStore(), env: { ...baseEnv, ...env } });
  const res = mockRes();
  await h(mockReq({ headers, body }), res);
  return { res, calls };
};

test('HTTP: success round trip returns a JSON-RPC response', async () => {
  const { res } = await post(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]) }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.jsonrpc, '2.0');
  assert.equal(res.json.result.task.status.state, 'TASK_STATE_COMPLETED');
});

test('HTTP: missing/wrong API key => 401 with JSON-RPC error and WWW-Authenticate; no work done', async () => {
  for (const headers of [{}, { 'x-api-key': 'wrong' }]) {
    const { res, calls } = await post(rpc('SendMessage', { message: v1Msg([dataPart(structuredBody())]) }), { headers });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json.error.code, -32020);
    assert.match(res.headers['www-authenticate'], /ApiKey/);
    assert.equal(calls.email, 0);
  }
});

test('HTTP: invalid JSON => 400 / -32700; wrong content type => 415; GET => 405; oversized => 413', async () => {
  const h = a2aHandler({ deps: fakeDeps().deps, store: newStore(), env: { ...baseEnv, MAX_BODY_BYTES: '1024' } });
  let res = mockRes();
  await h(mockReq({ headers: auth, body: '{nope' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json.error.code, -32700);

  res = mockRes();
  await h(mockReq({ headers: { ...auth, 'content-type': 'text/plain' }, body: '{}' }), res);
  assert.equal(res.statusCode, 415);

  res = mockRes();
  await h(mockReq({ method: 'GET', headers: auth }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');

  res = mockRes();
  await h(mockReq({ headers: auth, body: { pad: 'x'.repeat(3000) } }), res);
  assert.equal(res.statusCode, 413);
  assert.equal(res.json.error.code, -32022);
});

test('HTTP: rate limit => 429 with Retry-After; unsupported A2A-Version => -32009', async () => {
  const h = a2aHandler({ deps: fakeDeps().deps, store: newStore(), env: { ...baseEnv, RATE_LIMIT_PER_MINUTE: '1' } });
  const body = rpc('GetTask', { id: 'abc-123' });
  let res = mockRes();
  await h(mockReq({ headers: auth, body }), res);
  assert.equal(res.statusCode, 200);
  res = mockRes();
  await h(mockReq({ headers: auth, body }), res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.json.error.code, -32021);
  assert.equal(res.headers['retry-after'], '60');

  const { res: vres } = await post(body, { headers: { ...auth, 'a2a-version': '9.9' } });
  assert.equal(vres.json.error.code, -32009);
});

test('HTTP: production without API_KEY fails closed; secrets never appear in errors', async () => {
  const { res } = await post(rpc('GetTask', { id: 'x' }), { headers: {}, env: { NODE_ENV: 'production', API_KEY: '' } });
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(res.body, /smtp-secret|slm-secret/);
});
