import { randomUUID } from 'node:crypto';
import { AppError } from '../utils/errors.js';
import {
  RPC, RpcError, METHODS, TERMINAL_STATES, invalidParams, isValidId, checkVersion, parseInboundMessage,
  parseHistoryLength, checkOutputModes, serializeTask, rpcResult, rpcError,
} from './protocol.js';
import { createTaskStore } from './taskStore.js';
import { runInvoiceTask } from './executor.js';

// A "working" task untouched for this long is assumed dead (function timeout / crash).
const STALE_WORKING_MS = 150_000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Transport-independent A2A JSON-RPC handler.
 * Returns { status, body } where body is always a JSON-RPC response object.
 * Never throws: every failure becomes a JSON-RPC error with no internal detail.
 */
export async function handleA2ARequest(payload, { config, store, deps, version, now = () => new Date() }) {
  let id = null;
  try {
    if (!isObj(payload)) {
      throw new RpcError(RPC.INVALID_REQUEST, 'Request must be a single JSON-RPC 2.0 object (batch requests are not supported).');
    }
    if (typeof payload.id === 'string' || Number.isInteger(payload.id)) id = payload.id;
    if (payload.jsonrpc !== '2.0' || typeof payload.method !== 'string' || id === null) {
      throw new RpcError(RPC.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request: "jsonrpc":"2.0", a string "method" and a string or integer "id" are required.');
    }
    checkVersion(version);

    const method = Object.hasOwn(METHODS, payload.method) ? METHODS[payload.method] : undefined;
    if (!method) throw new RpcError(RPC.METHOD_NOT_FOUND, `Method not found: ${payload.method.slice(0, 60)}`);

    const params = payload.params ?? {};
    if (!isObj(params)) throw invalidParams('params must be an object.');

    const ctx = { config, deps, now, d: method.dialect, ts: createTaskStore(store) };
    const handlers = { send, get, cancel, list: unsupported, stream: unsupported, subscribe: unsupported, push: noPush, extendedCard: noExtendedCard };
    const result = await handlers[method.op](params, ctx, payload.method);
    return { status: 200, body: rpcResult(id, result) };
  } catch (err) {
    return toRpcResponse(id, err);
  }
}

function toRpcResponse(id, err) {
  if (err instanceof RpcError) {
    const status = err.code === RPC.INVALID_REQUEST || err.code === RPC.PARSE ? 400 : 200;
    return { status, body: rpcError(id, err.code, err.message, err.data) };
  }
  if (err instanceof AppError && err.code === 'STATE_STORE_UNAVAILABLE') {
    return { status: 200, body: rpcError(id, RPC.INTERNAL, 'Task storage is temporarily unavailable. Retry shortly.', { retryable: true }) };
  }
  console.error('[a2a] unexpected error:', err?.name ?? 'Error'); // never log message/stack: may contain customer data
  return { status: 200, body: rpcError(id, RPC.INTERNAL, 'Internal error.') };
}

// ---- Unsupported capabilities (declared false in the Agent Card) ----------------------------------

async function unsupported(_p, _c, method) {
  throw new RpcError(
    RPC.UNSUPPORTED_OPERATION,
    `${method} is not supported: this agent does not stream or list tasks. Use SendMessage / message/send and poll with GetTask / tasks/get.`,
  );
}
async function noPush() {
  throw new RpcError(RPC.PUSH_NOT_SUPPORTED, 'Push notifications are not supported by this agent.');
}
async function noExtendedCard() {
  throw new RpcError(RPC.EXTENDED_CARD_NOT_CONFIGURED, 'This agent has no extended Agent Card.');
}

// ---- Task helpers -------------------------------------------------------------------------------

/** Load a task; a stale "working" task is closed out as failed with an honest "outcome unknown" message. */
async function loadTask(ctx, taskId) {
  if (!isValidId(taskId)) return null;
  const task = await ctx.ts.getTask(taskId);
  if (!task) return null;
  const age = ctx.now().getTime() - Date.parse(task.status.timestamp);
  if (task.status.state === 'working' && age > STALE_WORKING_MS) {
    const message = {
      messageId: randomUUID(), role: 'agent', taskId: task.id, contextId: task.contextId,
      parts: [
        { text: 'Processing did not finish (the worker likely timed out). The outcome of the email step is unknown: check the recipient mailbox before retrying.' },
        { data: { error: 'PROCESSING_INTERRUPTED', retryable: false } },
      ],
    };
    const failed = { ...task, status: { state: 'failed', timestamp: ctx.now().toISOString(), message }, history: [...(task.history ?? []), message] };
    await ctx.ts.saveTask(failed);
    return failed;
  }
  return task;
}

const notFound = () => new RpcError(RPC.TASK_NOT_FOUND, 'Task not found (it may have expired).');

// ---- SendMessage / message/send -----------------------------------------------------------------

async function send(params, ctx) {
  const message = parseInboundMessage(params.message);
  const cfg = isObj(params.configuration) ? params.configuration : {};
  checkOutputModes(cfg.acceptedOutputModes);
  const historyLength = parseHistoryLength(cfg.historyLength);
  const reply = (task) => {
    const t = serializeTask(task, ctx.d, { historyLength });
    return ctx.d === '1.0' ? { task: t } : t;
  };

  let existing = null;
  if (message.taskId) {
    existing = await loadTask(ctx, message.taskId);
    if (!existing) throw notFound();
    if (message.contextId && message.contextId !== existing.contextId) {
      throw invalidParams('message.contextId does not match the task\'s contextId.');
    }
  }

  // Duplicate delivery of the same messageId must not run (or email) twice: replay the owning task instead.
  const taskId = existing?.id ?? randomUUID();
  let claim = await ctx.ts.claimMessage(message.messageId, taskId);
  if (!claim.claimed) {
    const owner = claim.taskId ? await loadTask(ctx, claim.taskId) : null;
    if (owner) return reply(owner);
    await ctx.ts.releaseMessage(message.messageId); // owner expired: treat as a fresh message
    claim = await ctx.ts.claimMessage(message.messageId, taskId);
    if (!claim.claimed) throw new RpcError(RPC.UNSUPPORTED_OPERATION, 'This messageId is being processed. Poll with GetTask / tasks/get.');
  }

  let locked = false;
  try {
    if (existing) {
      if (existing.status.state !== 'input-required') {
        const why = TERMINAL_STATES.has(existing.status.state)
          ? `Task is in terminal state "${existing.status.state}"; start a new task instead.`
          : 'Task is currently being processed.';
        throw new RpcError(RPC.UNSUPPORTED_OPERATION, why);
      }
      locked = await ctx.ts.acquireLock(existing.id);
      if (!locked) throw new RpcError(RPC.UNSUPPORTED_OPERATION, 'Task is currently being processed.');
    }

    const inbound = { ...message, taskId, contextId: existing?.contextId ?? message.contextId ?? randomUUID() };
    const working = {
      id: taskId,
      contextId: inbound.contextId,
      status: { state: 'working', timestamp: ctx.now().toISOString() },
      history: [...(existing?.history ?? []), inbound],
    };
    await ctx.ts.saveTask(working);

    const pending = existing ? await ctx.ts.getPending(taskId) : null;
    const outcome = await runInvoiceTask({ task: working, message: inbound, pending, config: ctx.config, deps: ctx.deps, now: ctx.now });

    await ctx.ts.saveTask(outcome.task);
    if (outcome.pending) await ctx.ts.savePending(taskId, outcome.pending);
    else await ctx.ts.clearPending(taskId).catch(() => {});

    // Failed runs delivered nothing, so the same messageId may be retried.
    if (outcome.task.status.state === 'failed') await ctx.ts.releaseMessage(message.messageId).catch(() => {});
    return reply(outcome.task);
  } catch (err) {
    await ctx.ts.releaseMessage(message.messageId).catch(() => {});
    throw err;
  } finally {
    if (locked) await ctx.ts.releaseLock(taskId).catch(() => {});
  }
}

// ---- GetTask / tasks/get ------------------------------------------------------------------------

async function get(params, ctx) {
  if (!isValidId(params.id)) throw invalidParams('params.id (task id) is required.');
  const historyLength = parseHistoryLength(params.historyLength);
  const task = await loadTask(ctx, params.id);
  if (!task) throw notFound();
  return serializeTask(task, ctx.d, { historyLength });
}

// ---- CancelTask / tasks/cancel ------------------------------------------------------------------

async function cancel(params, ctx) {
  if (!isValidId(params.id)) throw invalidParams('params.id (task id) is required.');
  const task = await loadTask(ctx, params.id);
  if (!task) throw notFound();

  const state = task.status.state;
  if (state === 'canceled') return serializeTask(task, ctx.d); // idempotent
  if (state !== 'input-required') {
    throw new RpcError(
      RPC.TASK_NOT_CANCELABLE,
      state === 'working' ? 'Task is mid-execution and cannot be interrupted.' : `Task is already in terminal state "${state}".`,
      { state },
    );
  }

  const message = {
    messageId: randomUUID(), role: 'agent', taskId: task.id, contextId: task.contextId,
    parts: [{ text: 'Task canceled at the caller\'s request. No invoice was sent.' }],
  };
  const canceled = { ...task, status: { state: 'canceled', timestamp: ctx.now().toISOString(), message }, history: [...(task.history ?? []), message] };
  await ctx.ts.saveTask(canceled);
  await ctx.ts.clearPending(task.id).catch(() => {});
  return serializeTask(canceled, ctx.d);
}
