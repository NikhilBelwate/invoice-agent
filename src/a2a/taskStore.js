import { createHash } from 'node:crypto';

/*
 * A2A task persistence on top of the shared state store (Upstash Redis when configured, otherwise
 * per-instance memory). With the memory fallback, GetTask only works against the same warm instance.
 */

const TASK_TTL = 86_400; // s: how long GetTask can find a task
const PENDING_TTL = 3_600; // s: how long an input-required task waits for a follow-up message
const LOCK_TTL = 120; // s: guards concurrent follow-ups to the same task
const MSG_TTL = 86_400; // s: messageId de-duplication window

const h = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

export function createTaskStore(store) {
  const readJson = async (key) => {
    const raw = await store.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null; // corrupted entry: behave as if absent
    }
  };

  return {
    getTask: (id) => readJson(`a2a:task:${h(id)}`),
    saveTask: (task) => store.set(`a2a:task:${h(task.id)}`, JSON.stringify(task), TASK_TTL),

    getPending: (id) => readJson(`a2a:pending:${h(id)}`),
    savePending: (id, body) => store.set(`a2a:pending:${h(id)}`, JSON.stringify(body), PENDING_TTL),
    clearPending: (id) => store.del(`a2a:pending:${h(id)}`),

    /** First caller to present a messageId owns it; later callers get the owning taskId. */
    async claimMessage(messageId, taskId) {
      const key = `a2a:msg:${h(messageId)}`;
      if (await store.setNx(key, taskId, MSG_TTL)) return { claimed: true };
      return { claimed: false, taskId: await store.get(key) };
    },
    releaseMessage: (messageId) => store.del(`a2a:msg:${h(messageId)}`),

    acquireLock: (taskId) => store.setNx(`a2a:lock:${h(taskId)}`, '1', LOCK_TTL),
    releaseLock: (taskId) => store.del(`a2a:lock:${h(taskId)}`),
  };
}
