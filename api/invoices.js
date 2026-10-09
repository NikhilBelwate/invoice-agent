import { getConfig } from '../src/config/env.js';
import { processInvoiceRequest } from '../src/agents/invoiceAgent.js';
import { createStore, checkRateLimit } from '../src/services/stateStore.js';
import { AppError } from '../src/utils/errors.js';
import { authenticate, clientIdentity, readJsonBody, sendError, sendJson } from './_http.js';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * POST /api/invoices
 * `deps` / `store` are only overridden by tests via createHandler().
 */
export function createHandler({ deps, store: storeOverride, env } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new AppError('METHOD_NOT_ALLOWED', 'Use POST.', 405);
      }

      const config = getConfig(env);
      authenticate(req, config);

      const store = storeOverride ?? createStore(config);
      const rl = await checkRateLimit(store, clientIdentity(req), config.RATE_LIMIT_PER_MINUTE);
      if (!rl.allowed) throw new AppError('RATE_LIMITED', 'Too many requests. Try again shortly.', 429);

      let idempotencyKey = req.headers['idempotency-key'];
      if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(String(idempotencyKey))) {
        throw new AppError('VALIDATION_ERROR', 'Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 . _ : -', 400);
      }
      idempotencyKey = idempotencyKey ? String(idempotencyKey) : undefined;

      const body = await readJsonBody(req, config.MAX_BODY_BYTES);
      const result = await processInvoiceRequest(body, { config, idempotencyKey, store, deps });
      sendJson(res, 200, result);
    } catch (err) {
      sendError(res, err);
    }
  };
}

export default createHandler();
