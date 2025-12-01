const WebSocket = require('ws');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailers',
]);

function encodeBody(buffer) {
  if (!buffer || buffer.length === 0) {
    return '';
  }
  return Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(buffer).toString('base64');
}

function decodeBody(base64) {
  if (!base64) return Buffer.alloc(0);
  return Buffer.from(base64, 'base64');
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sanitizeHeaders(headers = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!key) continue;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createLogger(scope) {
  return (...args) => {
    const stamp = new Date().toISOString();
    console.log(`[${stamp}] [${scope}]`, ...args);
  };
}

function createDebugLogger(enabled, scope) {
  const base = createLogger(scope);
  return (...args) => {
    if (!enabled) return;
    base(...args);
  };
}

function toWebSocketUrl(input) {
  if (!input) throw new Error('Missing server URL');
  if (input.startsWith('ws://') || input.startsWith('wss://')) return input;
  if (input.startsWith('http://')) return input.replace(/^http:\/\//i, 'ws://');
  if (input.startsWith('https://')) return input.replace(/^https:\/\//i, 'wss://');
  throw new Error('Server URL must start with http(s):// or ws(s)://');
}

function toHttpUrl(input) {
  if (!input) throw new Error('Missing server URL');
  if (input.startsWith('http://') || input.startsWith('https://')) return input;
  if (input.startsWith('ws://')) return input.replace(/^ws:\/\//i, 'http://');
  if (input.startsWith('wss://')) return input.replace(/^wss:\/\//i, 'https://');
  throw new Error('Server URL must start with http(s):// or ws(s)://');
}

function resolveSessionFromUrl(urlObj) {
  const segments = urlObj.pathname.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

function parseServerTarget(rawUrl, explicitSession) {
  const wsUrl = toWebSocketUrl(rawUrl);
  const httpUrl = toHttpUrl(rawUrl);
  const urlObj = new URL(httpUrl);
  const session = explicitSession || resolveSessionFromUrl(urlObj);
  if (!session) {
    throw new Error('Session not provided; include it as an argument or path segment');
  }
  return { wsUrl: new URL(wsUrl, wsUrl).toString(), httpUrl: urlObj.toString(), session };
}

module.exports = {
  encodeBody,
  decodeBody,
  safeSend,
  sanitizeHeaders,
  collectRequestBody,
  createLogger,
  createDebugLogger,
  parseServerTarget,
  toWebSocketUrl,
  toHttpUrl,
};
