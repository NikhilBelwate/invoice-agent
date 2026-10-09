# Invoice Agent

Accepts checkout info as JSON or plain text, extracts structured data with **Gemma 3 4B** (only when text needs parsing), computes every amount in Node (`decimal.js`), renders a PDF with **PDFKit** in memory, and emails it via **Nodemailer/SMTP**. Runs as Vercel Functions.

```
POST /api/invoices ─► auth ─► rate limit ─► body-size/Zod validation
                       ├─ {input:"text"} ─► Gemma (Ollama-compatible) ─► Zod validate (untrusted)
                       └─ structured JSON ─────────────────────────────► Zod validate (no SLM call)
                     ─► calculate + verify totals (decimal.js) ─► PDF (Buffer) ─► SMTP submit ─► JSON response
POST /api/a2a ─► same pipeline, exposed as A2A tasks (see §5b); GET /.well-known/agent-card.json ─► discovery
GET  /api/health ─► configuration status (no secrets)
```

| Layer | Files |
|---|---|
| Vercel handlers (thin) | `api/invoices.js`, `api/a2a.js`, `api/agent-card.js`, `api/health.js`, `api/_http.js` (auth, body reading, errors) |
| A2A layer | `src/a2a/{protocol,server,executor,taskStore,agentCard}.js` — no Vercel imports |
| Orchestration | `src/agents/invoiceAgent.js` — no Vercel imports; testable locally |
| Services | `src/services/{slmService,invoiceCalculationService,pdfService,emailService,stateStore}.js` |
| Validation / config / utils | `src/validators/invoiceValidator.js`, `src/config/env.js`, `src/utils/{money,invoiceNumber,errors}.js` |

## 1. External accounts you must set up

| Service | Why | Notes |
|---|---|---|
| **Gemma 3 4B endpoint** | Plain-text extraction | Vercel cannot run Ollama and has no `localhost:11434`. Use a reachable **HTTPS** Ollama-compatible endpoint (see §4). Not needed if you only send structured JSON. |
| **SMTP provider** | Sending invoices | Any SMTP account (SES, Postmark, SendGrid SMTP, Mailgun, Gmail app password, ...). |
| **Vercel account** | Hosting | `npm i -g vercel`, `vercel login`. |
| **Upstash Redis** (recommended) | Shared rate limiting + idempotency | Free tier is fine. Without it, an in-memory per-instance fallback is used (best effort only). |

## 2. Local setup

```bash
npm install
cp .env.example .env      # fill in values; .env is git-ignored
npm test                  # mocked unit/handler/e2e tests, no network
npm run dev               # = vercel dev  (serves http://localhost:3000/api/...)
```

`vercel dev` loads `.env` (or run `vercel env pull .env.local` after configuring Vercel). To expose a *local* Ollama to the app locally, `SLM_BASE_URL=http://localhost:11434` works for local development only; the health endpoint warns if this is set in production.

## 3. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | **Yes** | — | SMTP submission |
| `SMTP_PORT` / `SMTP_SECURE` | No | `587` / `false` | Use `465` + `true` for implicit TLS |
| `API_KEY` | **Yes in production** | — | Clients send `x-api-key`. Unset in production ⇒ API returns 503 (fails closed). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SLM_BASE_URL` | Yes for text input | — | Ollama: `https://ollama.example.com`. OpenAI-compatible: include the version path, e.g. `https://api.groq.com/openai/v1` |
| `SLM_MODEL` | No | `gemma3:4b` | Model identifier sent to the provider |
| `SLM_PROVIDER` | No | `ollama-compatible` | `ollama-compatible` (calls `{base}/api/chat`) or `openai-compatible` (calls `{base}/chat/completions`; e.g. Groq, OpenRouter, Together, vLLM) |
| `SLM_API_KEY` | If your endpoint needs it | — | Sent as `Authorization: Bearer ...`; never returned to clients |
| `SLM_TIMEOUT_MS` | No | `20000` | Model call timeout (1000–50000) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Recommended | — | Shared state for rate limits + idempotency |
| `RATE_LIMIT_PER_MINUTE` | No | `20` | Per client (API key + IP) |
| `MAX_BODY_BYTES` | No | `102400` | Hard request-size cap (413) |
| `PUBLIC_BASE_URL` | Recommended for A2A | derived from request | Origin advertised in the Agent Card |
| `BUSINESS_NAME`, `BUSINESS_EMAIL`, `BUSINESS_ADDRESS` | No | — | Printed on the PDF |
| `NODE_ENV` | No | `development` | Vercel sets `production` for production deployments |

### Setting them in Vercel (development / preview / production)

```bash
vercel link
vercel env add SMTP_HOST production        # repeat per variable; the CLI prompts for the value
vercel env add SMTP_PASS preview
vercel env add API_KEY development
vercel env ls
vercel env pull .env.local                 # pulls the "development" values for local use
```

Or use Dashboard → Project → Settings → Environment Variables and tick the environments for each variable. Mark `SMTP_PASS`, `SLM_API_KEY`, `API_KEY`, `UPSTASH_REDIS_REST_TOKEN` as **Sensitive**. Changes apply to *new* deployments only: redeploy afterwards. Use separate SMTP/API keys for preview vs production so previews can never email real customers with production credentials.

## 4. Hosting Gemma 3 4B

The app only needs `POST {SLM_BASE_URL}/api/chat` (Ollama chat API) and, for `/api/health?deep=1`, `GET {SLM_BASE_URL}/api/tags`.

* **Own server (simplest):** on a VM, `ollama pull gemma3:4b`, run Ollama bound to localhost, and put a TLS reverse proxy in front (Caddy/nginx) that requires `Authorization: Bearer <token>`. Set `SLM_BASE_URL=https://your-host` and `SLM_API_KEY=<token>`. A 4B model runs on CPU but is slow; budget ~5–15 s per request and keep `SLM_TIMEOUT_MS` comfortably under the function limit.
* **Hosted provider (OpenAI-style API):** set `SLM_PROVIDER=openai-compatible`, `SLM_BASE_URL=<provider base incl. /v1>`, `SLM_MODEL=<provider's exact model id>` and `SLM_API_KEY`. The app requests JSON mode and retries once without it if the provider rejects `response_format`. The app never substitutes a different model than the one configured. Example (Groq): `SLM_PROVIDER=openai-compatible`, `SLM_BASE_URL=https://api.groq.com/openai/v1`, `SLM_MODEL=openai/gpt-oss-20b`. Groq's catalog changes (Gemma may not be offered): list what your key can use with `GET https://api.groq.com/openai/v1/models` and avoid `*-guard-*` / `whisper-*` models.
* If the endpoint is down/unconfigured the API returns a clear `SLM_*` error; it never falls back to a different model.

## 5. API

Auth: `x-api-key: <API_KEY>`. Optional `Idempotency-Key: <8–128 chars>` header prevents duplicate emails on client retries.

### Plain text

```bash
curl -sS https://YOUR-APP.vercel.app/api/invoices \
  -H "content-type: application/json" -H "x-api-key: $API_KEY" -H "Idempotency-Key: order-8841-v1" \
  -d '{"input":"Generate an invoice for John Smith, john@example.com, 2 laptops at 50000 INR each, with 18% tax."}'
```

### Structured JSON

```bash
curl -sS https://YOUR-APP.vercel.app/api/invoices \
  -H "content-type: application/json" -H "x-api-key: $API_KEY" \
  -d '{"customerName":"John Smith","email":"john@example.com","currency":"INR",
       "items":[{"name":"Laptop","quantity":2,"unitPrice":50000},{"name":"Mouse","quantity":1,"unitPrice":1000}],
       "taxPercentage":18}'
```

Optional structured fields: `invoiceNumber`, `invoiceDate` (`YYYY-MM-DD`), `discount` (`{"type":"percentage"|"fixed","value":n}`), `paymentStatus`, `notes`, and caller-supplied `subtotal` / `taxAmount` / `grandTotal` (verified, never trusted). `currency` is required; no currency or tax rate is ever assumed.

### Success (200)

```json
{
  "success": true,
  "invoiceNumber": "INV-20261009-3F9A12BC",
  "invoiceNumberGenerated": true,
  "invoiceDate": "2026-10-09",
  "currency": "INR",
  "subtotal": 100000,
  "discountAmount": 0,
  "taxPercentage": 18,
  "taxAmount": 18000,
  "grandTotal": 118000,
  "pdfGenerated": true,
  "emailSubmitted": true,
  "message": "Invoice generated and email submitted successfully."
}
```

`emailSubmitted: true` means the SMTP server **accepted the message for the recipient**, not that it reached an inbox. A replayed idempotent request adds `"idempotentReplay": true`.

### Errors — `{ "success": false, "error": CODE, "message": "...", "details"?: [...] }`

| HTTP | `error` | Cause |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad JSON/schema, missing/invalid email, no valid products, discount > subtotal |
| 401 | `UNAUTHORIZED` | Missing/wrong `x-api-key` |
| 405 / 415 | `METHOD_NOT_ALLOWED` / `VALIDATION_ERROR` | Not POST / not `application/json` |
| 409 | `DUPLICATE_IN_PROGRESS` | Same `Idempotency-Key` still processing |
| 413 | `PAYLOAD_TOO_LARGE` | Body > `MAX_BODY_BYTES` |
| 422 | `FINANCIAL_DISCREPANCY` | Supplied subtotal/tax/total differs from calculated (`details` lists each) |
| 429 | `RATE_LIMITED` | Over `RATE_LIMIT_PER_MINUTE` (`Retry-After: 60`) |
| 500 | `PDF_GENERATION_FAILED` | Renderer error (nothing emailed) |
| 502 | `SLM_UNAVAILABLE` / `SLM_BAD_RESPONSE` / `EMAIL_FAILED` | Model endpoint error / unusable output / SMTP rejected |
| 503 | `CONFIG_ERROR` / `SLM_NOT_CONFIGURED` / `STATE_STORE_UNAVAILABLE` | Missing/invalid server config |
| 504 | `SLM_TIMEOUT` | Model did not answer within `SLM_TIMEOUT_MS` |

### Health

```bash
curl https://YOUR-APP.vercel.app/api/health
curl -H "x-api-key: $API_KEY" "https://YOUR-APP.vercel.app/api/health?deep=1"   # also probes the SLM endpoint + model
```

## 5b. A2A protocol (agent-to-agent)

Other agents can discover and call this agent over [A2A](https://a2a-protocol.org) (JSON-RPC binding). Both **1.0** and **0.3** wire formats are served from one endpoint; the response format follows the method name the caller used.

| | |
|---|---|
| Agent Card | `GET /.well-known/agent-card.json` (also `/.well-known/agent.json`) — public, no secrets, lists skill `generate-and-email-invoice` |
| Endpoint | `POST /api/a2a` — header `x-api-key`, optional `A2A-Version: 1.0` or `0.3` |
| 1.0 methods | `SendMessage`, `GetTask`, `CancelTask` |
| 0.3 methods | `message/send`, `tasks/get`, `tasks/cancel` |
| Not supported (declared `false` in the card) | streaming (`SendStreamingMessage`, `message/stream`, subscribe/resubscribe), push notifications, `ListTasks`, extended card — each returns its specific A2A error |

Set `PUBLIC_BASE_URL` (e.g. `https://invoice-agent.omega-x.com`) so the card advertises the right origin; otherwise it is derived from the request host.

**Input.** Send a *data part* with the structured invoice (`customerName, email, currency, items[], taxPercentage, discount?, ...`) or a *text part* with the purchase description (this uses the language model). File parts are rejected (`-32005`).

**Task states.** The call blocks until the work is done (a few seconds) and returns a Task:

| State | When | What the caller gets |
|---|---|---|
| `completed` | PDF generated and SMTP accepted the email | artifact `invoice-summary` (data part with amounts, invoice number, flags) |
| `input-required` | missing/invalid email or products, bad currency, or supplied totals that don't match | agent message explaining each problem. **Reply with another message carrying the same `taskId`** containing the missing/corrected fields (data parts are merged, text is appended). Pending input expires after 1 h |
| `failed` | model, PDF, SMTP, config or unexpected error | agent message + data part `{ "error": "<CODE>", "retryable": true|false }`. Nothing was emailed unless the message says the outcome is unknown |
| `canceled` | `CancelTask` on an `input-required` task | — (completed/failed tasks return `TaskNotCancelableError`; cancel is idempotent) |

Business-level problems are task states, not protocol errors; JSON-RPC errors are reserved for protocol problems.

**Exactly-once sending.** `message.messageId` is the idempotency key: re-delivering the same `messageId` returns the original task and never emails twice. A `failed` task releases its `messageId`, so the same message can be retried. A task stuck in `working` for more than 150 s (function timeout) is reported as `failed` with `PROCESSING_INTERRUPTED` — *the email outcome is then unknown; check before retrying*. Tasks are kept 24 h in Upstash Redis; **without Upstash they live in per-instance memory and `GetTask` may miss them** across serverless instances.

### Error codes (JSON-RPC `error.code`)

| Code | Meaning | HTTP |
|---|---|---|
| -32700 | Invalid JSON | 400 |
| -32600 | Invalid request (batch, missing jsonrpc/id/method, wrong content type, non-POST) | 400 / 415 / 405 |
| -32601 / -32602 / -32603 | Method not found / invalid params (bad message, role, parts, ids, historyLength) / internal (also: task storage unavailable, `data.retryable:true`) | 200 |
| -32001 | TaskNotFound (unknown or expired) | 200 |
| -32002 | TaskNotCancelable | 200 |
| -32003 | PushNotificationNotSupported | 200 |
| -32004 | UnsupportedOperation (streaming/list; follow-up to a finished or busy task; messageId in flight) | 200 |
| -32005 | ContentTypeNotSupported (file parts, unusable `acceptedOutputModes`) | 200 |
| -32007 | ExtendedAgentCardNotConfigured | 200 |
| -32009 | VersionNotSupported (`A2A-Version` other than 0.3 / 1.0) | 200 |
| -32020 / -32021 / -32022 | Unauthorized / rate limited (`Retry-After`) / payload too large (server-defined) | 401 / 429 / 413 |

### Example (1.0)

```bash
curl -sS https://YOUR-APP.vercel.app/api/a2a -H "content-type: application/json" -H "x-api-key: $API_KEY" -H "A2A-Version: 1.0" -d '{
  "jsonrpc":"2.0","id":1,"method":"SendMessage",
  "params":{"message":{"messageId":"order-8841-v1","role":"ROLE_USER","parts":[
    {"data":{"customerName":"John Smith","email":"john@example.com","currency":"CAD",
             "items":[{"name":"Laptop","quantity":2,"unitPrice":50000}],"taxPercentage":11}}]}}}'
```

```json
{"jsonrpc":"2.0","id":1,"result":{"task":{"id":"7b0c…","contextId":"3f9a…",
  "status":{"state":"TASK_STATE_COMPLETED","timestamp":"2026-10-09T12:00:00.000Z",
            "message":{"messageId":"…","role":"ROLE_AGENT","parts":[{"text":"Invoice INV-… generated (CAD 111000) and submitted to the SMTP server. SMTP acceptance does not confirm inbox delivery."}]}},
  "artifacts":[{"artifactId":"…","name":"invoice-summary","parts":[{"data":{"invoiceNumber":"INV-…","grandTotal":111000,"emailSubmitted":true},"mediaType":"application/json"}]}]}}}
```

0.3 equivalent: `"method":"message/send"`, `"role":"user"`, parts as `{"kind":"data","data":{…}}`; the result is the Task itself (`"kind":"task"`, state `"completed"`).

Verify discovery after deploying: `curl https://YOUR-APP.vercel.app/.well-known/agent-card.json`.

## 6. Calculation & rounding policy

line total = `round(qty × unitPrice)`; subtotal = Σ line totals; discount (percentage or fixed) is applied to the subtotal; tax = `round((subtotal − discount) × rate)` (tax **after** discount); grand total = subtotal − discount + tax. Rounding is ROUND_HALF_UP to the currency's minor unit (JPY/KRW/VND… 0, KWD/BHD/OMR… 3, default 2). Supplied totals must match within one minor unit or the request fails with 422. The SLM never calculates anything; amounts it copies from text are only *checked*.

## 7. Security & reliability notes

* SLM output is untrusted: Zod-validated, unknown keys dropped, and the extracted email must literally occur in the submitted text. The recipient is always the validated email; SLM output cannot influence file paths (nothing is written to disk) or headers.
* Credentials are only read from env, never logged or returned. SMTP errors expose only the error code category.
* **Idempotency:** with `Idempotency-Key` + Upstash, a duplicate request replays the stored result without re-sending. The key is released if the attempt fails (so a retry is possible). If the function dies *after* SMTP accepted but before the result is recorded, a retry after the 120 s in-flight window could send again — inherent to any non-transactional send. Without Upstash this protection is per-instance only.
* No automatic email retries. No invoice is stored: the PDF exists only in memory and as the email attachment; the response does not claim durable storage. Generated invoice numbers are random (`INV-YYYYMMDD-XXXXXXXX`) and **not** guaranteed globally unique — supply your own `invoiceNumber` if you need that.
* Rate limiting fails open (with a log warning) if Upstash is unreachable; idempotency fails closed (503) so a duplicate can't slip through.
* **Duration limits:** `vercel.json` sets `maxDuration: 60` for `/api/invoices` (SLM ≤ 20 s + PDF < 1 s + SMTP ≈ few s). Check your plan's limit; if a slow model endpoint pushes past it, move to an async design: accept the request, enqueue (Vercel Queues / Upstash QStash), and have a worker call `processInvoiceRequest` — it is Vercel-independent for exactly that reason.

## 8. Tests

```bash
npm test                  # 90 mocked tests: calc, validation, SLM failures/timeouts, SMTP/PDF failures,
                          # idempotency, handlers (auth, limits, health), env/production config, e2e
```

`npm run test:integration` runs the live tests (real Gemma + real SMTP). They are skipped unless:

```bash
RUN_INTEGRATION=1 INTEGRATION_TO_EMAIL=you@example.com npm run test:integration   # with SLM_* / SMTP_* exported
```

## 9. Deploy and verify on Vercel

```bash
vercel                       # preview deployment
vercel --prod                # production deployment
```

1. Set all variables (§3) for the target environment, then redeploy.
2. `curl https://<deployment>/api/health` → expect `"status":"ok"`, `smtp.configured:true`, `auth.apiKeyConfigured:true`, and no `warnings` you care about.
3. `curl -H "x-api-key: $API_KEY" "https://<deployment>/api/health?deep=1"` → `slm.probe.reachable:true, modelAvailable:true`.
4. Send a structured-JSON request to your own mailbox (no SLM involved), then a plain-text one.
5. Preview deployments behind Vercel Deployment Protection need a bypass token or protection disabled to be called from outside.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| 503 `CONFIG_ERROR` "authentication is not configured" | `API_KEY` missing in a production deployment (redeploy after adding it) |
| 503 `SLM_NOT_CONFIGURED` | `SLM_BASE_URL` empty. Health shows `slm.configured:false` |
| 503 `SLM_NOT_CONFIGURED` "not a chat model" | `SLM_MODEL` is a classifier/speech/embedding model (e.g. `llama-prompt-guard-*`, `llama-guard-*`, `whisper-*`). Pick a chat model from `GET {SLM_BASE_URL}/models` |
| 502 `SLM_UNAVAILABLE` "does not serve model" (HTTP 404) | Wrong API style: an OpenAI-style host (Groq, OpenRouter, ...) needs `SLM_PROVIDER=openai-compatible` and a base URL ending in `/v1`; or the model id is wrong/retired |
| 502 `SLM_UNAVAILABLE` | Endpoint unreachable from Vercel (localhost/private IP/firewall), wrong token, or model not pulled (`ollama pull gemma3:4b`). Run `/api/health?deep=1` |
| 504 `SLM_TIMEOUT` | Cold model load or CPU inference; keep model warm (`OLLAMA_KEEP_ALIVE=24h`) or raise `SLM_TIMEOUT_MS` (≤ 50000) |
| 502 `SLM_BAD_RESPONSE` / 400 on text input | Model returned non-JSON, or email not present verbatim in the text. Resend or use structured JSON |
| 502 `EMAIL_FAILED (EAUTH)` | Wrong SMTP credentials / app password required |
| 502 `EMAIL_FAILED (ECONNECTION/ETIMEDOUT/ESOCKET)` | Port blocked or wrong `SMTP_SECURE` (465 ⇒ `true`, 587 ⇒ `false`) |
| 422 `FINANCIAL_DISCREPANCY` | Your supplied totals differ from the policy in §6; fix or omit them |
| 401 on `?deep=1` | Deep health requires `x-api-key` |
| PDF fonts error on Vercel | Ensure `vercel.json` `includeFiles` for `node_modules/pdfkit/js/data/**` is kept |
