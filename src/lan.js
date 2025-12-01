const WebSocket = require('ws');
const net = require('net');
const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const fetchHttp = require('node-fetch');
const {
  decodeBody,
  encodeBody,
  sanitizeHeaders,
  safeSend,
  createLogger,
  createDebugLogger,
  parseServerTarget,
} = require('./common');

function normalizeResponseHeaders(headers) {
  if (headers && typeof headers.raw === 'function') {
    return headers.raw();
  }
  const result = {};
  for (const [key, value] of headers.entries()) {
    if (result[key]) {
      result[key] = Array.isArray(result[key]) ? [...result[key], value] : [result[key], value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function performHttpRequest(request) {
  const { method, url, headers = {}, bodyBase64 } = request;
  const body = decodeBody(bodyBase64);
  const init = {
    method,
    headers: sanitizeHeaders(headers),
    body: body.length ? body : undefined,
    redirect: 'manual',
  };
  const response = await fetch(url, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: normalizeResponseHeaders(response.headers),
    bodyBase64: encodeBody(buffer),
  };
}

function buildProxyAgent(proxyUrl, insecure) {
  if (!proxyUrl) return null;
  const url = new URL(proxyUrl);
  const opts = { rejectUnauthorized: !insecure };
  if (url.protocol === 'http:') return new HttpProxyAgent(url, opts);
  return new HttpsProxyAgent(url, opts);
}

function buildDirectAgent(insecure) {
  if (!insecure) return null;
  return new https.Agent({ rejectUnauthorized: false });
}

function startLan({ serverUrl, session, proxyUrl, insecure = false, transport = 'ws', debug = false }) {
  const { wsUrl, httpUrl, session: resolvedSession } = parseServerTarget(serverUrl, session);
  const log = createLogger(`lan:${resolvedSession}`);
  const dlog = createDebugLogger(debug, `lan:${resolvedSession}:debug`);
  const agentUrl = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const proxyAgent = buildProxyAgent(agentUrl, insecure);
  const directAgent = buildDirectAgent(insecure);
  const fetchAgent = proxyAgent || directAgent;

  const tunnels = new Map(); // id -> net.Socket

  function handleMessage(payload, sendFn) {
    switch (payload.type) {
      case 'hello-ack':
        return;
      case 'http-request': {
        const { id, request } = payload;
        performHttpRequest(request)
          .then((result) => sendFn({ type: 'http-response', id, ...result }))
          .catch((err) => {
            log(`Request failed for ${request?.url || 'unknown'}: ${err.message || err}`);
            sendFn({ type: 'http-response', id, error: err.message || 'Request failed' });
          });
        break;
      }
      case 'connect-start': {
        const { id, host, port } = payload;
        if (!host || !port) {
          sendFn({ type: 'connect-error', id, message: 'Invalid host/port' });
          break;
        }
        const socket = net.createConnection({ host, port: Number(port) }, () => {
          sendFn({ type: 'connect-ack', id });
        });
        tunnels.set(id, socket);

        socket.on('data', (chunk) => {
          sendFn({ type: 'connect-data', id, dataBase64: encodeBody(chunk) });
        });

        socket.on('error', (err) => {
          sendFn({ type: 'connect-error', id, message: err.message || 'Socket error' });
          socket.destroy();
          tunnels.delete(id);
        });

        socket.on('end', () => {
          sendFn({ type: 'connect-end', id });
          socket.destroy();
          tunnels.delete(id);
        });

        break;
      }
      case 'connect-data': {
        const { id, dataBase64 } = payload;
        const socket = tunnels.get(id);
        if (socket) {
          socket.write(decodeBody(dataBase64));
        } else {
          sendFn({ type: 'connect-error', id, message: 'Unknown tunnel' });
        }
        break;
      }
      case 'connect-end': {
        const { id } = payload;
        const socket = tunnels.get(id);
        if (socket) {
          socket.end();
          tunnels.delete(id);
        }
        break;
      }
      default:
        log(`Unsupported message type: ${payload.type}`);
    }
  }

  if (transport === 'http') {
    const httpBase = new URL(httpUrl);
    const baseHttp = httpBase.origin; // server root (no session path)

    async function sendHttp(message) {
      const url = `${baseHttp}/api/tunnel/${encodeURIComponent(resolvedSession)}/send`;
      const body = JSON.stringify({ role: 'lan', message });
      dlog('HTTP send', url, body.slice(0, 200), 'curl:', `curl -k${fetchAgent ? ' --proxy ' + agentUrl : ''} -H "content-type: application/json" -d '${body}' ${url}`);
      await fetchHttp(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        agent: fetchAgent,
      });
    }

    async function poll() {
      for (;;) {
        try {
          const url = `${baseHttp}/api/tunnel/${encodeURIComponent(resolvedSession)}/recv?role=lan`;
          dlog('HTTP recv', url, 'curl:', `curl -k${fetchAgent ? ' --proxy ' + agentUrl : ''} -i ${url}`);
          const res = await fetchHttp(url, {
            method: 'GET',
            agent: fetchAgent,
          });
          dlog('HTTP recv status', res.status, res.statusText);
          if (res.status === 204) continue;
          if (!res.ok) {
            let bodyText = '';
            try {
              bodyText = await res.text();
            } catch (_) {}
            log(`HTTP recv failed: ${res.status}${bodyText ? ` body: ${bodyText.slice(0, 200)}` : ''}`);
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          const text = await res.text();
          if (!text) continue;
          const payload = JSON.parse(text);
          handleMessage(payload, sendHttp);
        } catch (err) {
          log(`HTTP poll error: ${err.message || err}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    sendHttp({ type: 'hello', role: 'lan', session: resolvedSession }).catch((err) =>
      log(`Hello failed: ${err.message || err}`)
    );
    poll();
    log(`using HTTP tunnel to ${baseHttp}${agentUrl ? ` via proxy ${agentUrl}` : ''}`);
    return { transport: 'http' };
  }

  const wsOptions = {};
  if (proxyAgent) wsOptions.agent = proxyAgent;
  if (insecure) wsOptions.rejectUnauthorized = false;
  const ws = new WebSocket(wsUrl, wsOptions);

  ws.on('open', () => {
    safeSend(ws, { type: 'hello', role: 'lan', session: resolvedSession });
    log(`connected to server ${wsUrl}${agentUrl ? ` via proxy ${agentUrl}` : ''}`);
  });

  ws.on('close', () => {
    log('connection closed');
    tunnels.forEach((socket) => socket.destroy());
    tunnels.clear();
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message || err}`);
  });

  ws.on('message', (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch (err) {
      log('Invalid JSON from server');
      return;
    }
    handleMessage(payload, (p) => safeSend(ws, p));
  });

  return { ws };
}

module.exports = { startLan };
