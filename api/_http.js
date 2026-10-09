import { timingSafeEqual, createHash } from 'node:crypto';
import { AppError, toErrorResponse } from '../src/utils/errors.js';

export function sendJson(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  const { status, body } = toErrorResponse(err);
  if (!(err instanceof AppError)) console.error('[api] unexpected error:', err?.name ?? 'Error'); // never log message/stack content with customer data
  const headers = status === 429 ? { 'Retry-After': '60' } : {};
  sendJson(res, status, body, headers);
}

const sha = (s) => createHash('sha256').update(String(s)).digest();

/** Constant-time API key check. In production a missing API_KEY blocks all traffic (fail closed). */
export function authenticate(req, config) {
  if (!config.API_KEY) {
    if (config.isProduction) {
      throw new AppError('CONFIG_ERROR', 'API authentication is not configured on the server.', 503);
    }
    return; // development convenience only
  }
  const provided = req.headers['x-api-key'] ?? '';
  if (typeof provided !== 'string' || !timingSafeEqual(sha(provided), sha(config.API_KEY))) {
    throw new AppError('UNAUTHORIZED', 'Missing or invalid API key.', 401);
  }
}

export function clientIdentity(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  return `${req.headers['x-api-key'] ? 'key' : 'anon'}:${ip}`;
}

/** Read and parse a JSON body with a hard size limit. Works whether or not the platform pre-parsed it. */
export async function readJsonBody(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413);
  }
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().includes('application/json')) {
    throw new AppError('VALIDATION_ERROR', 'Content-Type must be application/json.', 415);
  }

  let raw;
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
    else if (typeof req.body === 'string') raw = req.body;
    else {
      if (Buffer.byteLength(JSON.stringify(req.body)) > maxBytes) {
        throw new AppError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413);
      }
      return req.body;
    }
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413);
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }

  if (Buffer.byteLength(raw) > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`, 413);
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new AppError('VALIDATION_ERROR', 'Request body is not valid JSON.', 400), { kind: 'invalid_json' });
  }
}
