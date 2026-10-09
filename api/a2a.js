import { getConfig } from '../src/config/env.js';
import { AppError } from '../src/utils/errors.js';
import { createStore, checkRateLimit } from '../src/services/stateStore.js';
import { handleA2ARequest } from '../src/a2a/server.js';
import { RPC, rpcError } from '../src/a2a/protocol.js';
import { authenticate, clientIdentity, readJsonBody, sendJson } from './_http.js';

/** Transport-level failures (before a JSON-RPC request exists) as JSON-RPC errors with matching HTTP statuses. */
function sendTransportError(res, err) {
  let status = 500;
  let code = RPC.INTERNAL;
  let message = 'Internal error.';
  const headers = {};

  if (err instanceof AppError) {
    if (err.code === 'UNAUTHORIZED') {
      [status, code, message] = [401, RPC.UNAUTHORIZED, 'Missing or invalid API key.'];
      headers['WWW-Authenticate'] = 'ApiKey realm="invoice-agent", header="x-api-key"';
    } else if (err.code === 'RATE_LIMITED') {
      [status, code, message] = [429, RPC.RATE_LIMITED, 'Too many requests. Try again shortly.'];
      headers['Retry-After'] = '60';
    } else if (err.code === 'PAYLOAD_TOO_LARGE') {
      [status, code, message] = [413, RPC.PAYLOAD_TOO_LARGE, err.message];
    } else if (err.kind === 'invalid_json') {
      [status, code, message] = [400, RPC.PARSE, 'Parse error: request body is not valid JSON.'];
    } else if (err.status === 415) {
      [status, code, message] = [415, RPC.INVALID_REQUEST, 'Content-Type must be application/json.'];
    } else if (err.code === 'CONFIG_ERROR') {
      [status, code, message] = [503, RPC.INTERNAL, 'The server is not configured correctly.'];
    }
  } else {
    console.error('[a2a] unexpected transport error:', err?.name ?? 'Error');
  }
  sendJson(res, status, rpcError(null, code, message), headers);
}

/**
 * POST /api/a2a — A2A JSON-RPC endpoint (protocol versions 1.0 and 0.3).
 * `deps` / `store` / `env` / `now` are overridden by tests only.
 */
export function createHandler({ deps, store: storeOverride, env, now } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, rpcError(null, RPC.INVALID_REQUEST, 'Use POST with a JSON-RPC 2.0 body.'), { Allow: 'POST' });
      }

      const config = getConfig(env);
      authenticate(req, config);

      const store = storeOverride ?? createStore(config);
      const rl = await checkRateLimit(store, clientIdentity(req), config.RATE_LIMIT_PER_MINUTE);
      if (!rl.allowed) throw new AppError('RATE_LIMITED', 'Too many requests.', 429);

      const payload = await readJsonBody(req, config.MAX_BODY_BYTES);
      const version = req.headers['a2a-version'];
      const { status, body } = await handleA2ARequest(payload, { config, store, deps, now, version: Array.isArray(version) ? version[0] : version });
      sendJson(res, status, body);
    } catch (err) {
      sendTransportError(res, err);
    }
  };
}

export default createHandler();
