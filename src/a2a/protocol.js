import { MAX_INPUT_CHARS } from '../validators/invoiceValidator.js';

/*
 * A2A protocol primitives (JSON-RPC binding). Two wire dialects are served from one endpoint:
 *   1.0  PascalCase methods (SendMessage), no `kind`, TASK_STATE_* / ROLE_* enums, flat parts
 *   0.3  slash methods (message/send), `kind` discriminators, lowercase states ("input-required")
 * The dialect of a response always follows the dialect of the request's method name.
 * Internally tasks use one canonical shape: lowercase states, parts {text} | {data}.
 */

export const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  EXTENDED_CARD_NOT_CONFIGURED: -32007,
  EXTENSION_SUPPORT_REQUIRED: -32008,
  VERSION_NOT_SUPPORTED: -32009,
  // Server-defined (outside the A2A-reserved -32001..-32009 block); sent with matching HTTP statuses.
  UNAUTHORIZED: -32020,
  RATE_LIMITED: -32021,
  PAYLOAD_TOO_LARGE: -32022,
};

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export const invalidParams = (message, data) => new RpcError(RPC.INVALID_PARAMS, message, data);

export const SUPPORTED_VERSIONS = ['0.3', '1.0'];
export const INPUT_MODES = ['text/plain', 'application/json'];
export const OUTPUT_MODES = ['application/json', 'text/plain'];

export const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rejected']);

/** op: what the server does; dialect: wire format of the request AND response. */
export const METHODS = {
  SendMessage: { op: 'send', dialect: '1.0' },
  'message/send': { op: 'send', dialect: '0.3' },
  SendStreamingMessage: { op: 'stream', dialect: '1.0' },
  'message/stream': { op: 'stream', dialect: '0.3' },
  GetTask: { op: 'get', dialect: '1.0' },
  'tasks/get': { op: 'get', dialect: '0.3' },
  ListTasks: { op: 'list', dialect: '1.0' },
  CancelTask: { op: 'cancel', dialect: '1.0' },
  'tasks/cancel': { op: 'cancel', dialect: '0.3' },
  SubscribeToTask: { op: 'subscribe', dialect: '1.0' },
  'tasks/resubscribe': { op: 'subscribe', dialect: '0.3' },
  CreateTaskPushNotificationConfig: { op: 'push', dialect: '1.0' },
  GetTaskPushNotificationConfig: { op: 'push', dialect: '1.0' },
  ListTaskPushNotificationConfigs: { op: 'push', dialect: '1.0' },
  DeleteTaskPushNotificationConfig: { op: 'push', dialect: '1.0' },
  'tasks/pushNotificationConfig/set': { op: 'push', dialect: '0.3' },
  'tasks/pushNotificationConfig/get': { op: 'push', dialect: '0.3' },
  'tasks/pushNotificationConfig/list': { op: 'push', dialect: '0.3' },
  'tasks/pushNotificationConfig/delete': { op: 'push', dialect: '0.3' },
  GetExtendedAgentCard: { op: 'extendedCard', dialect: '1.0' },
  'agent/getAuthenticatedExtendedCard': { op: 'extendedCard', dialect: '0.3' },
};

/** A2A-Version header: empty/absent means "client did not say" (0.3 per spec, which we also serve). */
export function checkVersion(header) {
  if (header === undefined || header === null || String(header).trim() === '') return;
  const m = String(header).trim().match(/^(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?$/);
  if (!m || !SUPPORTED_VERSIONS.includes(`${m[1]}.${m[2]}`)) {
    throw new RpcError(
      RPC.VERSION_NOT_SUPPORTED,
      `Unsupported A2A version. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}.`,
      { supportedVersions: SUPPORTED_VERSIONS },
    );
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
export const isValidId = (v) => typeof v === 'string' && ID.test(v);

/** Validate an inbound Message (either dialect) into the canonical shape. */
export function parseInboundMessage(raw) {
  if (!isObj(raw)) throw invalidParams('params.message is required and must be an object.');
  const { messageId, role, parts, contextId, taskId } = raw;
  if (!isValidId(messageId)) throw invalidParams('message.messageId is required (1-128 characters: letters, digits, . _ : -).');
  if (role !== 'user' && role !== 'ROLE_USER') throw invalidParams('message.role must be "user" (or "ROLE_USER" in 1.0).');
  if (contextId !== undefined && !isValidId(contextId)) throw invalidParams('message.contextId is invalid.');
  if (taskId !== undefined && !isValidId(taskId)) throw invalidParams('message.taskId is invalid.');
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 20) {
    throw invalidParams('message.parts must be an array of 1 to 20 parts.');
  }

  let textChars = 0;
  const out = parts.map((p, i) => {
    if (!isObj(p)) throw invalidParams(`message.parts[${i}] must be an object.`);
    if (p.kind === 'file' || 'file' in p || 'raw' in p || 'url' in p) {
      throw new RpcError(
        RPC.CONTENT_TYPE_NOT_SUPPORTED,
        'File parts are not supported. Send text/plain or application/json (data) parts.',
        { supportedInputModes: INPUT_MODES },
      );
    }
    if (typeof p.text === 'string') {
      textChars += p.text.length;
      return { text: p.text };
    }
    if ('data' in p && isObj(p.data)) return { data: p.data };
    throw invalidParams(`message.parts[${i}] must be a text part or a data part holding a JSON object.`);
  });
  if (textChars > MAX_INPUT_CHARS) throw invalidParams(`Text content exceeds ${MAX_INPUT_CHARS} characters.`);

  return { messageId, role: 'user', parts: out, contextId, taskId };
}

export function parseHistoryLength(v) {
  if (v === undefined || v === null) return 0;
  if (!Number.isInteger(v) || v < 0 || v > 100) throw invalidParams('historyLength must be an integer from 0 to 100.');
  return v;
}

export function checkOutputModes(modes) {
  if (modes === undefined || modes === null) return;
  if (!Array.isArray(modes) || modes.some((m) => typeof m !== 'string')) {
    throw invalidParams('configuration.acceptedOutputModes must be an array of media types.');
  }
  if (modes.length > 0 && !modes.some((m) => OUTPUT_MODES.includes(m.toLowerCase()))) {
    throw new RpcError(
      RPC.CONTENT_TYPE_NOT_SUPPORTED,
      'None of the accepted output modes can be produced by this agent.',
      { supportedOutputModes: OUTPUT_MODES },
    );
  }
}

// ---- Serialization ------------------------------------------------------------------------------

const stateOut = (s, d) => (d === '1.0' ? `TASK_STATE_${s.toUpperCase().replace(/-/g, '_')}` : s);

function partOut(p, d) {
  if ('text' in p) return d === '1.0' ? { text: p.text } : { kind: 'text', text: p.text };
  return d === '1.0' ? { data: p.data, mediaType: 'application/json' } : { kind: 'data', data: p.data };
}

export function serializeMessage(m, d) {
  const out = {
    messageId: m.messageId,
    role: d === '1.0' ? (m.role === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER') : m.role,
    parts: m.parts.map((p) => partOut(p, d)),
  };
  if (m.contextId) out.contextId = m.contextId;
  if (m.taskId) out.taskId = m.taskId;
  return d === '1.0' ? out : { kind: 'message', ...out };
}

export function serializeTask(t, d, { historyLength = 0 } = {}) {
  const status = { state: stateOut(t.status.state, d), timestamp: t.status.timestamp };
  if (t.status.message) status.message = serializeMessage(t.status.message, d);
  const out = { id: t.id, contextId: t.contextId, status };
  if (t.artifacts?.length) {
    out.artifacts = t.artifacts.map((a) => ({
      artifactId: a.artifactId,
      name: a.name,
      description: a.description,
      parts: a.parts.map((p) => partOut(p, d)),
    }));
  }
  if (historyLength > 0 && t.history?.length) {
    out.history = t.history.slice(-historyLength).map((m) => serializeMessage(m, d));
  }
  return d === '1.0' ? out : { kind: 'task', ...out };
}

export const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
