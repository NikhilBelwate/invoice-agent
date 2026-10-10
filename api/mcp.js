import { createHash, timingSafeEqual } from 'node:crypto';
import { getConfig } from '../src/config/env.js';
import { AppError } from '../src/utils/errors.js';
import { createStore, checkRateLimit } from '../src/services/stateStore.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { CODES, rpcError } from '../src/mcp/protocol.js';
import { clientIdentity, readJsonBody, sendJson } from './_http.js';

const sha = (s) => createHash('sha256').update(String(s)).digest();

/** x-api-key: <key>  or  Authorization: Bearer <key>. In production a missing API_KEY fails closed. */
function authenticate(req, config) {
  if (!config.API_KEY) {
    if (config.isProduction) throw new AppError('CONFIG_ERROR', 'API authentication is not configured on the server.', 503);
    return; // development convenience only
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
  const provided = req.headers['x-api-key'] ?? bearer ?? '';
  if (typeof provided !== 'string' || !timingSafeEqual(sha(provided), sha(config.API_KEY))) {
    throw new AppError('UNAUTHORIZED', 'Missing or invalid API key.', 401);
  }
}

/** DNS-rebinding protection: a browser Origin must be same-host or explicitly allow-listed. Non-browser clients send none. */
function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const allowed = config.MCP_ALLOWED_ORIGINS ? config.MCP_ALLOWED_ORIGINS.split(',').map((s) => s.trim().replace(/\/+$/, '')) : [];
  if (allowed.includes(String(origin).replace(/\/+$/, ''))) return true;
  try {
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sendTransportError(res, err) {
  let status = 500;
  let code = CODES.INTERNAL;
  let message = 'Internal error.';
  const headers = {};

  if (err instanceof AppError) {
    if (err.code === 'UNAUTHORIZED') {
      [status, code, message] = [401, CODES.UNAUTHORIZED, 'Missing or invalid API key.'];
      headers['WWW-Authenticate'] = 'Bearer realm="invoice-agent"';
    } else if (err.code === 'RATE_LIMITED') {
      [status, code, message] = [429, CODES.RATE_LIMITED, 'Too many requests. Try again shortly.'];
      headers['Retry-After'] = '60';
    } else if (err.code === 'PAYLOAD_TOO_LARGE') {
      [status, code, message] = [413, CODES.PAYLOAD_TOO_LARGE, err.message];
    } else if (err.kind === 'invalid_json') {
      [status, code, message] = [400, CODES.PARSE, 'Parse error: request body is not valid JSON.'];
    } else if (err.status === 415) {
      [status, code, message] = [415, CODES.INVALID_REQUEST, 'Content-Type must be application/json.'];
    } else if (err.code === 'CONFIG_ERROR') {
      [status, code, message] = [503, CODES.INTERNAL, 'The server is not configured correctly.'];
    }
  } else {
    console.error('[mcp] unexpected transport error:', err?.name ?? 'Error');
  }
  sendJson(res, status, rpcError(null, code, message), headers);
}

/**
 * POST /api/mcp — MCP Streamable HTTP endpoint (stateless; JSON responses; no sessions, no SSE).
 * `deps` / `store` / `env` / `now` are overridden by tests only.
 */
export function createHandler({ deps, store: storeOverride, env, now } = {}) {
  return async function handler(req, res) {
    try {
      const config = getConfig(env);

      if (!originAllowed(req, config)) {
        return sendJson(res, 403, rpcError(null, CODES.INVALID_REQUEST, 'Origin not allowed.'));
      }
      if (req.method !== 'POST') {
        // No server-initiated stream (GET) and no sessions (DELETE) in this stateless server.
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, rpcError(null, CODES.INVALID_REQUEST, 'Use POST with a JSON-RPC 2.0 body.'), { Allow: 'POST' });
      }

      authenticate(req, config);
      const store = storeOverride ?? createStore(config);
      const rl = await checkRateLimit(store, clientIdentity(req), config.RATE_LIMIT_PER_MINUTE);
      if (!rl.allowed) throw new AppError('RATE_LIMITED', 'Too many requests.', 429);

      const payload = await readJsonBody(req, config.MAX_BODY_BYTES);
      const { status, body } = await handleMcpRequest(payload, { config, store, deps, now, headers: req.headers });

      if (body === null) {
        res.statusCode = status; // 202 Accepted for notifications, no body
        res.setHeader('Cache-Control', 'no-store');
        return res.end();
      }
      sendJson(res, status, body);
    } catch (err) {
      sendTransportError(res, err);
    }
  };
}

export default createHandler();
