import { getConfig } from '../src/config/env.js';
import { createMemoryStore } from '../src/services/stateStore.js';

export const baseEnv = {
  NODE_ENV: 'test',
  SLM_BASE_URL: 'https://slm.example.com',
  SLM_MODEL: 'gemma3:4b',
  SLM_API_KEY: 'slm-secret',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'smtp-user',
  SMTP_PASS: 'smtp-secret',
  EMAIL_FROM: 'billing@example.com',
  API_KEY: 'test-api-key',
  BUSINESS_NAME: 'Acme Corp',
};

export const makeConfig = (overrides = {}) => getConfig({ ...baseEnv, ...overrides });
export const newStore = createMemoryStore;

export const structuredBody = (extra = {}) => ({
  customerName: 'John Smith',
  email: 'john@example.com',
  currency: 'INR',
  items: [
    { name: 'Laptop', quantity: 2, unitPrice: 50000 },
    { name: 'Mouse', quantity: 1, unitPrice: 1000 },
  ],
  taxPercentage: 18,
  ...extra,
});

/** Fake deps recording calls. */
export function fakeDeps(overrides = {}) {
  const calls = { extract: 0, pdf: 0, email: 0 };
  const deps = {
    extract: async () => {
      calls.extract++;
      return structuredBody();
    },
    generatePdf: async (inv) => {
      calls.pdf++;
      return { buffer: Buffer.from('%PDF-fake'), filename: 'invoice-test.pdf' };
    },
    sendEmail: async () => {
      calls.email++;
      return { submitted: true };
    },
    ...overrides,
  };
  return { deps, calls };
}

/** Minimal req/res doubles for the Vercel handlers. */
export function mockReq({ method = 'POST', headers = {}, body, url = '/' } = {}) {
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const h = { 'content-type': 'application/json', ...headers };
  if (raw !== undefined) h['content-length'] = String(Buffer.byteLength(raw));
  return {
    method,
    url,
    headers: h,
    socket: { remoteAddress: '203.0.113.9' },
    async *[Symbol.asyncIterator]() {
      if (raw !== undefined) yield Buffer.from(raw);
    },
  };
}

export function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(b) {
      this.body = b ?? '';
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
  return res;
}
