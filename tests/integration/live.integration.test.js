// Live integration test: uses the REAL Gemma endpoint and the REAL SMTP server configured in the environment.
// Skipped unless RUN_INTEGRATION=1. Sends one real email to INTEGRATION_TO_EMAIL.
//   RUN_INTEGRATION=1 INTEGRATION_TO_EMAIL=you@example.com npm run test:integration   (with .env values exported)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../../src/config/env.js';
import { processInvoiceRequest } from '../../src/agents/invoiceAgent.js';
import { pingSlm } from '../../src/services/slmService.js';

const enabled = process.env.RUN_INTEGRATION === '1' && process.env.INTEGRATION_TO_EMAIL;
const opts = { skip: enabled ? false : 'set RUN_INTEGRATION=1 and INTEGRATION_TO_EMAIL to run' };

test('live: SLM endpoint is reachable and serves the configured model', opts, async () => {
  const config = getConfig();
  const probe = await pingSlm(config.slm);
  assert.equal(probe.reachable, true);
  assert.equal(probe.modelAvailable, true, `model ${config.slm.model} not available`);
});

test('live: plain text -> Gemma -> PDF -> real SMTP submission', opts, async () => {
  const config = getConfig();
  const to = process.env.INTEGRATION_TO_EMAIL;
  const r = await processInvoiceRequest(
    { input: `Generate an invoice for Integration Test, ${to}. 2 laptops at 50000 INR each and 1 mouse at 1000 INR. Apply 18% tax.` },
    { config },
  );
  assert.equal(r.success, true);
  assert.equal(r.grandTotal, 119180);
  assert.equal(r.emailSubmitted, true);
});
