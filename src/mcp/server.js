import { AGENT_VERSION } from '../a2a/agentCard.js';
import {
  ALL_VERSIONS, LEGACY_VERSIONS, MODERN_VERSIONS, LATEST_LEGACY, META, CODES, McpError, rpcResult, rpcError, decodeHeaderValue,
} from './protocol.js';
import { TOOLS, runTool } from './tools.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const SERVER_INFO = { name: 'invoice-agent', title: 'Invoice Agent', version: AGENT_VERSION };
const INSTRUCTIONS =
  'Invoice tools. generate_invoice_pdf returns a PDF and sends nothing; send_invoice_email generates the PDF and emails it to the customer ' +
  'address in the invoice data (ask the user to confirm before calling it). Provide structured fields or a plain-text description. ' +
  'Currency is required and tax is never assumed. If a result has isError=true, read the message, correct the input and retry.';
const CAPABILITIES = { tools: { listChanged: false } };

/**
 * Transport-independent MCP handler (JSON-RPC over Streamable HTTP, stateless).
 * Returns { status, body } where body is a JSON-RPC response, or null for accepted notifications (HTTP 202).
 * Never throws: every failure becomes a JSON-RPC error without internal detail.
 */
export async function handleMcpRequest(payload, ctx) {
  const headers = ctx.headers ?? {};
  const header = (name) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  let id = null;
  let era = 'legacy';

  try {
    if (!isObj(payload)) {
      throw new McpError(CODES.INVALID_REQUEST, 'Request must be a single JSON-RPC 2.0 object (batch requests are not supported).', { status: 400 });
    }
    if (payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
      throw new McpError(CODES.INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request: "jsonrpc":"2.0" and a string "method" are required.', { status: 400 });
    }

    // Notifications (no id) are accepted and ignored: initialized, cancelled, ... (stateless server).
    if (!('id' in payload)) return { status: 202, body: null };
    if (typeof payload.id !== 'string' && !Number.isInteger(payload.id)) {
      throw new McpError(CODES.INVALID_REQUEST, 'Request "id" must be a string or an integer.', { status: 400 });
    }
    id = payload.id;

    const params = payload.params ?? {};
    if (!isObj(params)) throw new McpError(CODES.INVALID_PARAMS, 'params must be an object.');

    era = detectEra(payload.method, params, header('mcp-protocol-version'));
    if (era === 'modern') validateModernRequest(payload.method, params, header);
    else validateLegacyHeader(header('mcp-protocol-version'));

    const result = await dispatch(payload.method, params, era, ctx);
    return { status: 200, body: rpcResult(id, decorate(result, era)) };
  } catch (err) {
    return toErrorResponse(id, err, era);
  }
}

function toErrorResponse(id, err, era) {
  if (err instanceof McpError) {
    return { status: err.status, body: rpcError(id, err.code, err.message, err.data) };
  }
  console.error('[mcp] unexpected error:', err?.name ?? 'Error'); // never log message/stack: may contain customer data
  return { status: 500, body: rpcError(id, CODES.INTERNAL, 'Internal error.') };
}

// ---- Era detection and validation -----------------------------------------------------------------------

function detectEra(method, params, versionHeader) {
  if (method === 'initialize') return 'legacy';
  if (method === 'server/discover') return 'modern';
  if (isObj(params._meta) && META.version in params._meta) return 'modern';
  if (MODERN_VERSIONS.includes(versionHeader)) return 'modern';
  return 'legacy';
}

function unsupportedVersion(requested) {
  return new McpError(CODES.UNSUPPORTED_VERSION, 'Unsupported protocol version', {
    status: 400,
    data: { supported: ALL_VERSIONS, requested: String(requested).slice(0, 40) },
  });
}

function validateLegacyHeader(versionHeader) {
  // Absent header => 2025-03-26 per spec. A present-but-unknown value is rejected.
  if (versionHeader !== undefined && !ALL_VERSIONS.includes(versionHeader)) throw unsupportedVersion(versionHeader);
}

function validateModernRequest(method, params, header) {
  const meta = isObj(params._meta) ? params._meta : {};
  const requested = meta[META.version];
  if (typeof requested !== 'string' || !isObj(meta[META.clientCapabilities])) {
    throw new McpError(
      CODES.INVALID_PARAMS,
      `Missing required _meta fields: "${META.version}" (string) and "${META.clientCapabilities}" (object).`,
      { status: 400 },
    );
  }
  if (!MODERN_VERSIONS.includes(requested)) throw unsupportedVersion(requested);

  const mismatch = (msg) => new McpError(CODES.HEADER_MISMATCH, `Header mismatch: ${msg}`, { status: 400 });
  const versionHeader = header('mcp-protocol-version');
  if (versionHeader === undefined) throw mismatch('MCP-Protocol-Version header is required.');
  if (versionHeader !== requested) throw mismatch('MCP-Protocol-Version header does not match _meta protocolVersion.');
  const methodHeader = header('mcp-method');
  if (methodHeader === undefined) throw mismatch('Mcp-Method header is required.');
  if (methodHeader !== method) throw mismatch('Mcp-Method header does not match the request method.');
  if (method === 'tools/call') {
    const nameHeader = header('mcp-name');
    if (nameHeader === undefined) throw mismatch('Mcp-Name header is required for tools/call.');
    if (decodeHeaderValue(nameHeader) !== params.name) throw mismatch('Mcp-Name header does not match params.name.');
  }
}

/** Modern results carry resultType and the server identity in _meta. */
function decorate(result, era) {
  if (era !== 'modern') return result;
  return { resultType: 'complete', ...result, _meta: { ...(result._meta ?? {}), [META.serverInfo]: SERVER_INFO } };
}

// ---- Methods ---------------------------------------------------------------------------------------------

async function dispatch(method, params, era, ctx) {
  switch (method) {
    case 'initialize':
      return initialize(params);
    case 'ping':
      return {};
    case 'server/discover':
      return { supportedVersions: ALL_VERSIONS, capabilities: CAPABILITIES, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: 'public' };
    case 'tools/list':
      // Deterministic order, no pagination (two tools).
      return era === 'modern' ? { tools: TOOLS, ttlMs: 300_000, cacheScope: 'public' } : { tools: TOOLS };
    case 'tools/call':
      return callTool(params, ctx);
    default:
      throw new McpError(CODES.METHOD_NOT_FOUND, `Method not found: ${method.slice(0, 60)}`, { status: era === 'modern' ? 404 : 200 });
  }
}

function initialize(params) {
  if (typeof params.protocolVersion !== 'string') {
    throw new McpError(CODES.INVALID_PARAMS, 'initialize requires params.protocolVersion.');
  }
  // Echo a supported legacy version, otherwise offer our latest legacy version (client decides whether to continue).
  const protocolVersion = LEGACY_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LATEST_LEGACY;
  return { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
}

async function callTool(params, ctx) {
  if (typeof params.name !== 'string' || !params.name) throw new McpError(CODES.INVALID_PARAMS, 'tools/call requires params.name.');
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw new McpError(CODES.INVALID_PARAMS, `Unknown tool: ${params.name.slice(0, 60)}`);
  const args = params.arguments ?? {};
  if (!isObj(args)) throw new McpError(CODES.INVALID_PARAMS, 'params.arguments must be an object.');
  return runTool(tool.name, args, ctx);
}
