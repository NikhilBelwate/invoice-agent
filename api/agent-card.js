import { getConfig } from '../src/config/env.js';
import { AppError } from '../src/utils/errors.js';
import { buildAgentCard, resolveBaseUrl } from '../src/a2a/agentCard.js';
import { sendError, sendJson } from './_http.js';

/**
 * GET /.well-known/agent-card.json (rewritten to this function in vercel.json).
 * Public discovery document: no authentication, no secrets.
 */
export function createHandler({ env } = {}) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        throw new AppError('METHOD_NOT_ALLOWED', 'Use GET.', 405);
      }
      const config = getConfig(env);
      const card = buildAgentCard({ baseUrl: resolveBaseUrl(req, config), config });
      sendJson(res, 200, card, { 'Cache-Control': 'public, max-age=300' });
    } catch (err) {
      sendError(res, err);
    }
  };
}

export default createHandler();
