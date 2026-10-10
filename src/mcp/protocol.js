/*
 * MCP protocol primitives for the Streamable HTTP binding, serving two "eras" from one endpoint:
 *   legacy  2025-03-26 .. 2025-11-25   `initialize` handshake, optional MCP-Protocol-Version header
 *   modern  2026-07-28                 stateless: per-request `_meta`, Mcp-Method / Mcp-Name headers,
 *                                      `server/discover`, `resultType` on every result
 * The server is stateless in both eras (no Mcp-Session-Id is ever issued).
 */

export const LEGACY_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'];
export const MODERN_VERSIONS = ['2026-07-28'];
export const ALL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const LATEST_LEGACY = LEGACY_VERSIONS[LEGACY_VERSIONS.length - 1];

export const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
};

export const CODES = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // Defined by MCP 2026-07-28 (reserved sub-range):
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
  // Application-defined, deliberately outside the JSON-RPC/MCP reserved ranges:
  UNAUTHORIZED: -31401,
  PAYLOAD_TOO_LARGE: -31413,
  RATE_LIMITED: -31429,
};

export class McpError extends Error {
  constructor(code, message, { status = 200, data } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** Mcp-Name / Mcp-Param values may be sent as =?base64?<utf8>?= when not header-safe. */
export function decodeHeaderValue(value) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(String(value));
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : String(value);
}
