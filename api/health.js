import { getConfig, configStatus } from '../src/config/env.js';
import { pingSlm } from '../src/services/slmService.js';
import { AppError } from '../src/utils/errors.js';
import { authenticate, sendError, sendJson } from './_http.js';

/** GET /api/health — configuration status only, never secrets. `?deep=1` (API key required) also probes the SLM. */
export function createHandler({ env, fetchImpl } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new AppError('METHOD_NOT_ALLOWED', 'Use GET.', 405);
      }
      const config = getConfig(env);
      const status = configStatus(config);
      const body = { success: true, status: status.ready ? 'ok' : 'degraded', ...status };

      const deep = new URL(req.url ?? '/', 'http://localhost').searchParams.get('deep') === '1';
      if (deep) {
        authenticate(req, config);
        try {
          body.slm.probe = await pingSlm(config.slm, { fetchImpl });
        } catch (err) {
          body.slm.probe = { reachable: false, error: err instanceof AppError ? err.code : 'UNKNOWN' };
          body.status = 'degraded';
        }
      }
      sendJson(res, 200, body);
    } catch (err) {
      sendError(res, err);
    }
  };
}

export default createHandler();
