import { INPUT_MODES, OUTPUT_MODES } from './protocol.js';

export const AGENT_VERSION = '1.1.0';

/**
 * Agent Card served at /.well-known/agent-card.json.
 * It carries both the 1.0 fields (supportedInterfaces, securityRequirements) and the 0.3 fields
 * (protocolVersion, url, preferredTransport, security) so clients of either version can read it.
 * Nothing secret is included; the card is public by design.
 */
export function buildAgentCard({ baseUrl, config }) {
  const url = `${baseUrl}/api/a2a`;
  const org = config.business?.name || 'Invoice Agent';

  return {
    name: 'Invoice Agent',
    description:
      'Creates a professional PDF invoice from checkout details (structured JSON or plain text) and emails it to the customer. ' +
      'All amounts are calculated deterministically; the language model is used only to read free text. ' +
      'Missing or inconsistent details put the task in input-required so the calling agent can supply them.',
    version: AGENT_VERSION,
    provider: { organization: org, url: baseUrl },

    // A2A 1.0
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ],
    // A2A 0.3
    protocolVersion: '0.3.0',
    url,
    preferredTransport: 'JSONRPC',
    supportsAuthenticatedExtendedCard: false,

    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false, extendedAgentCard: false },

    securitySchemes: {
      apiKey: {
        apiKeySecurityScheme: { location: 'header', name: 'x-api-key', description: 'API key issued by the operator of this agent.' }, // 1.0
        type: 'apiKey', in: 'header', name: 'x-api-key', description: 'API key issued by the operator of this agent.', // 0.3
      },
    },
    securityRequirements: [{ schemes: { apiKey: { list: [] } } }], // 1.0
    security: [{ apiKey: [] }], // 0.3

    defaultInputModes: INPUT_MODES,
    defaultOutputModes: OUTPUT_MODES,

    skills: [
      {
        id: 'generate-and-email-invoice',
        name: 'Generate and email an invoice',
        description:
          'Validates checkout data, calculates subtotal/discount/tax/total, renders a PDF and emails it to the customer. ' +
          'Send either a data part with { customerName, email, currency, items:[{name,quantity,unitPrice}], taxPercentage, discount?, invoiceNumber?, invoiceDate?, paymentStatus?, notes? } ' +
          'or a text part describing the purchase. Currency is required; no currency or tax rate is ever assumed.',
        tags: ['invoice', 'billing', 'pdf', 'email'],
        examples: [
          'Generate an invoice for John Smith, john@example.com, 2 laptops at 50000 INR each, with 18% tax.',
          '{"customerName":"John Smith","email":"john@example.com","currency":"INR","items":[{"name":"Laptop","quantity":2,"unitPrice":50000}],"taxPercentage":18}',
        ],
        inputModes: INPUT_MODES,
        outputModes: OUTPUT_MODES,
      },
    ],
  };
}

/** Public base URL: PUBLIC_BASE_URL wins; otherwise derive it from the request's forwarded host. */
export function resolveBaseUrl(req, config) {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  const safeHost = /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host) ? host : 'localhost';
  const proto = /^localhost|^127\./.test(safeHost) ? 'http' : 'https';
  return `${proto}://${safeHost}`;
}
