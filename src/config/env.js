import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { isNonChatModel, isProviderNameAsModel, looksOpenAiStyle } from '../services/slmService.js';

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? '').trim().toLowerCase() === 'true');

const blank = (v) => (v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim());

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  SLM_PROVIDER: z.string().default('ollama-compatible'),
  SLM_BASE_URL: z.string().url().optional(),
  SLM_MODEL: z.string().default('gemma3:4b'),
  SLM_API_KEY: z.string().optional(),
  SLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(50000).default(20000),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  API_KEY: z.string().optional(),
  MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(1_000_000).default(102400),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(20),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  BUSINESS_NAME: z.string().optional(),
  BUSINESS_EMAIL: z.string().optional(),
  BUSINESS_ADDRESS: z.string().optional(),
});

/**
 * Parse process.env (or a supplied object) into a typed config.
 * Empty strings are treated as unset. Throws CONFIG_ERROR on malformed values.
 */
export function getConfig(env = process.env) {
  const cleaned = Object.fromEntries(Object.keys(schema.shape).map((k) => [k, blank(env[k])]));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.'));
    throw new AppError('CONFIG_ERROR', `Invalid server configuration for: ${fields.join(', ')}.`, 503);
  }
  const c = parsed.data;
  return {
    ...c,
    isProduction: c.NODE_ENV === 'production',
    slm: {
      provider: c.SLM_PROVIDER,
      baseUrl: c.SLM_BASE_URL?.replace(/\/+$/, ''),
      model: c.SLM_MODEL,
      apiKey: c.SLM_API_KEY,
      timeoutMs: c.SLM_TIMEOUT_MS,
    },
    smtp: {
      host: c.SMTP_HOST,
      port: c.SMTP_PORT,
      secure: c.SMTP_SECURE,
      user: c.SMTP_USER,
      pass: c.SMTP_PASS,
      from: c.EMAIL_FROM,
    },
    business: { name: c.BUSINESS_NAME, email: c.BUSINESS_EMAIL, address: c.BUSINESS_ADDRESS },
    upstash: c.UPSTASH_REDIS_REST_URL && c.UPSTASH_REDIS_REST_TOKEN
      ? { url: c.UPSTASH_REDIS_REST_URL.replace(/\/+$/, ''), token: c.UPSTASH_REDIS_REST_TOKEN }
      : null,
  };
}

const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?$)/i;

export function isLocalUrl(url) {
  try {
    return LOCAL_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Booleans/labels only — safe to expose from /api/health. */
export function configStatus(config) {
  const slmConfigured = Boolean(config.slm.baseUrl);
  const smtpConfigured = Boolean(config.smtp.host && config.smtp.user && config.smtp.pass && config.smtp.from);
  const warnings = [];
  if (config.isProduction && slmConfigured && isLocalUrl(config.slm.baseUrl)) {
    warnings.push('SLM_BASE_URL points to a local address, which is unreachable from Vercel.');
  }
  if (slmConfigured && config.slm.provider === 'ollama-compatible' && looksOpenAiStyle(config.slm.baseUrl)) {
    warnings.push('SLM_BASE_URL looks like an OpenAI-style API but SLM_PROVIDER is ollama-compatible; set SLM_PROVIDER=openai-compatible.');
  }
  if (isProviderNameAsModel(config.slm.model)) {
    warnings.push(`SLM_MODEL is "${config.slm.model}", which is a provider name: SLM_PROVIDER and SLM_MODEL look swapped.`);
  } else if (isNonChatModel(config.slm.model)) {
    warnings.push(`SLM_MODEL "${config.slm.model}" is not a chat model and cannot extract invoice data.`);
  }
  if (config.isProduction && !config.API_KEY) warnings.push('API_KEY is not set; the API will refuse requests.');
  if (!config.upstash) warnings.push('Upstash Redis not configured; rate limiting and idempotency are per-instance only.');
  return {
    environment: config.NODE_ENV,
    slm: { configured: slmConfigured, provider: config.slm.provider, model: config.slm.model, authConfigured: Boolean(config.slm.apiKey) },
    smtp: { configured: smtpConfigured },
    auth: { apiKeyConfigured: Boolean(config.API_KEY) },
    state: { store: config.upstash ? 'upstash' : 'memory' },
    business: { configured: Boolean(config.business.name) },
    warnings,
    ready: smtpConfigured && Boolean(config.API_KEY || !config.isProduction),
  };
}
