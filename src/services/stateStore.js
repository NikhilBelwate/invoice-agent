import { createHash } from 'node:crypto';
import { AppError } from '../utils/errors.js';

/*
 * Shared state for rate limiting and idempotency.
 *  - Upstash Redis (REST) when configured: shared across all serverless instances.
 *  - In-memory fallback otherwise: per warm instance only, best effort. Not safe for
 *    duplicate-send protection across instances; configure Upstash for production.
 */

export const hashKey = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

class MemoryStore {
  constructor() {
    this.map = new Map();
    this.kind = 'memory';
  }
  _get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e;
  }
  async incr(key, ttlSec) {
    const e = this._get(key);
    if (e) {
      e.value = Number(e.value) + 1;
      return e.value;
    }
    this.map.set(key, { value: 1, exp: Date.now() + ttlSec * 1000 });
    return 1;
  }
  async setNx(key, value, ttlSec) {
    if (this._get(key)) return false;
    this.map.set(key, { value, exp: Date.now() + ttlSec * 1000 });
    return true;
  }
  async set(key, value, ttlSec) {
    this.map.set(key, { value, exp: Date.now() + ttlSec * 1000 });
  }
  async get(key) {
    return this._get(key)?.value ?? null;
  }
  async del(key) {
    this.map.delete(key);
  }
}

class UpstashStore {
  constructor({ url, token }, fetchImpl = fetch) {
    this.url = url;
    this.token = token;
    this.fetch = fetchImpl;
    this.kind = 'upstash';
  }
  async cmd(args) {
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new AppError('STATE_STORE_UNAVAILABLE', 'The shared state store is unavailable.', 503);
    }
    if (!res.ok) throw new AppError('STATE_STORE_UNAVAILABLE', 'The shared state store is unavailable.', 503);
    return (await res.json()).result;
  }
  async incr(key, ttlSec) {
    const n = await this.cmd(['INCR', key]);
    if (n === 1) await this.cmd(['EXPIRE', key, ttlSec]);
    return n;
  }
  async setNx(key, value, ttlSec) {
    return (await this.cmd(['SET', key, value, 'NX', 'EX', ttlSec])) === 'OK';
  }
  async set(key, value, ttlSec) {
    await this.cmd(['SET', key, value, 'EX', ttlSec]);
  }
  async get(key) {
    return this.cmd(['GET', key]);
  }
  async del(key) {
    await this.cmd(['DEL', key]);
  }
}

let memorySingleton;
export function createStore(config, fetchImpl) {
  if (config.upstash) return new UpstashStore(config.upstash, fetchImpl);
  memorySingleton ??= new MemoryStore();
  return memorySingleton;
}
export const createMemoryStore = () => new MemoryStore();

/** Fixed-window rate limiter. Fails open (with a warning) if the store is down; the API key still gates access. */
export async function checkRateLimit(store, identity, limitPerMinute) {
  const window = Math.floor(Date.now() / 60_000);
  try {
    const n = await store.incr(`rl:${hashKey(identity)}:${window}`, 70);
    return { allowed: n <= limitPerMinute, remaining: Math.max(0, limitPerMinute - n) };
  } catch {
    console.warn('[rate-limit] store unavailable; allowing request');
    return { allowed: true, remaining: limitPerMinute };
  }
}

const PROCESSING_TTL = 120; // s: how long an in-flight marker blocks duplicates
const DONE_TTL = 86_400; // s: how long a completed result is replayed

export const idempotency = {
  /** Returns { status: 'new' } | { status: 'processing' } | { status: 'done', response }. */
  async begin(store, rawKey) {
    const key = `idem:${hashKey(rawKey)}`;
    if (await store.setNx(key, JSON.stringify({ state: 'processing' }), PROCESSING_TTL)) {
      return { status: 'new', key };
    }
    const existing = JSON.parse((await store.get(key)) ?? '{"state":"processing"}');
    return existing.state === 'done' ? { status: 'done', response: existing.response, key } : { status: 'processing', key };
  },
  async complete(store, key, response) {
    await store.set(key, JSON.stringify({ state: 'done', response }), DONE_TTL);
  },
  async release(store, key) {
    await store.del(key);
  },
};
