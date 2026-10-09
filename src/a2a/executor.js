import { randomUUID } from 'node:crypto';
import { processInvoiceRequest } from '../agents/invoiceAgent.js';
import { AppError } from '../utils/errors.js';

/*
 * Runs one invoice job for an A2A message and maps every outcome to a task state:
 *   success                               -> completed   (+ invoice-summary data artifact)
 *   VALIDATION_ERROR / FINANCIAL_DISCREPANCY -> input-required (caller can fix and reply on the same task)
 *   anything else (SLM, PDF, SMTP, config) -> failed      (+ machine-readable { error, retryable })
 * This function never throws: all failures are reported through the task.
 */

const INPUT_REQUIRED_CODES = new Set(['VALIDATION_ERROR', 'FINANCIAL_DISCREPANCY']);
// Failures where nothing was delivered and the same request may succeed later.
const RETRYABLE_CODES = new Set(['SLM_TIMEOUT', 'SLM_UNAVAILABLE', 'SLM_BAD_RESPONSE', 'EMAIL_FAILED', 'STATE_STORE_UNAVAILABLE']);

/** Turn a message into a request body understood by processInvoiceRequest(). */
export function messageToBody(message) {
  const data = message.parts.find((p) => 'data' in p)?.data;
  if (data) return data;
  return { input: message.parts.filter((p) => 'text' in p).map((p) => p.text).join('\n').trim() };
}

/** Combine the saved body of an input-required task with the caller's follow-up. */
export function mergeBodies(pending, next) {
  if (!pending) return next;
  const pendingText = typeof pending.input === 'string';
  const nextText = typeof next.input === 'string';
  if (pendingText && nextText) return { input: `${pending.input}\n${next.input}`.slice(-4000) };
  if (!pendingText && !nextText) return { ...pending, ...next }; // follow-up fields override
  return next; // text <-> structured switch: the new input replaces the old one
}

function describeProblems(err) {
  const lines = (Array.isArray(err.details) ? err.details : []).slice(0, 10).map((d) => {
    if (d.problem) return `- ${d.field}: ${d.problem}`;
    const base = `- ${d.field}: supplied ${d.supplied}, calculated ${d.calculated}`;
    return d.reason ? `${base} (${d.reason})` : base;
  });
  const hint =
    err.code === 'FINANCIAL_DISCREPANCY'
      ? 'Reply on this task with corrected values, or omit the supplied subtotal/taxAmount/grandTotal so they are calculated.'
      : 'Reply on this task (same taskId) with the missing or corrected fields as text or as a data part.';
  return [err.message, ...lines, hint].join('\n');
}

const agentMessage = (task, parts) => ({ messageId: randomUUID(), role: 'agent', parts, taskId: task.id, contextId: task.contextId });

function settle(task, state, message, nowIso, artifacts) {
  return {
    ...task,
    status: { state, timestamp: nowIso, message },
    artifacts: artifacts ?? task.artifacts,
    history: [...(task.history ?? []), message],
  };
}

export async function runInvoiceTask({ task, message, pending, config, deps, now = () => new Date() }) {
  const body = mergeBodies(pending, messageToBody(message));
  const nowIso = () => now().toISOString();

  try {
    const result = await processInvoiceRequest(body, { config, deps });
    const text =
      `Invoice ${result.invoiceNumber} generated (${result.currency} ${result.grandTotal}) and submitted to the SMTP server. ` +
      'SMTP acceptance does not confirm inbox delivery.';
    const msg = agentMessage(task, [{ text }]);
    const artifact = {
      artifactId: randomUUID(),
      name: 'invoice-summary',
      description: 'Calculated invoice amounts and processing status.',
      parts: [{ data: result }],
    };
    return { task: settle(task, 'completed', msg, nowIso(), [artifact]), pending: null };
  } catch (err) {
    if (err instanceof AppError && INPUT_REQUIRED_CODES.has(err.code)) {
      const msg = agentMessage(task, [{ text: describeProblems(err) }, { data: { error: err.code, details: err.details ?? null } }]);
      return { task: settle(task, 'input-required', msg, nowIso()), pending: body };
    }

    const known = err instanceof AppError;
    const code = known ? err.code : 'INTERNAL_ERROR';
    const text = known ? err.message : 'An unexpected error occurred while processing the invoice.';
    if (!known) console.error('[a2a] unexpected executor error:', err?.name ?? 'Error'); // no message/stack: may hold customer data
    const msg = agentMessage(task, [{ text }, { data: { error: code, retryable: RETRYABLE_CODES.has(code) } }]);
    return { task: settle(task, 'failed', msg, nowIso()), pending: null };
  }
}
