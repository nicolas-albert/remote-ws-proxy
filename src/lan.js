const WebSocket = require('ws');
const net = require('net');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { decodeBody, encodeBody, sanitizeHeaders, safeSend, createLogger, parseServerTarget } = require('./common');

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

function startLan({ serverUrl, session, proxyUrl, insecure = false }) {
  const { wsUrl, session: resolvedSession } = parseServerTarget(serverUrl, session);
  const log = createLogger(`lan:${resolvedSession}`);
  const agentUrl = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const wsOptions = {};
  if (agentUrl) wsOptions.agent = new HttpsProxyAgent(agentUrl);
  if (insecure) wsOptions.rejectUnauthorized = false;
  const ws = new WebSocket(wsUrl, wsOptions);
  const tunnels = new Map(); // id -> net.Socket

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

  ws.on('message', async (data) => {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch (err) {
      log('Invalid JSON from server');
      return;
    }

    switch (payload.type) {
      case 'hello-ack':
        // No-op; useful for connectivity confirmation
        return;
      case 'http-request': {
        const { id, request } = payload;
        try {
          const result = await performHttpRequest(request);
          safeSend(ws, { type: 'http-response', id, ...result });
        } catch (err) {
          log(`Request failed for ${request?.url || 'unknown'}: ${err.message || err}`);
          safeSend(ws, { type: 'http-response', id, error: err.message || 'Request failed' });
        }
        break;
      }
      case 'connect-start': {
        const { id, host, port } = payload;
        if (!host || !port) {
          safeSend(ws, { type: 'connect-error', id, message: 'Invalid host/port' });
          break;
        }
        const socket = net.createConnection({ host, port: Number(port) }, () => {
          safeSend(ws, { type: 'connect-ack', id });
        });
        tunnels.set(id, socket);

        socket.on('data', (chunk) => {
          safeSend(ws, { type: 'connect-data', id, dataBase64: encodeBody(chunk) });
        });

        socket.on('error', (err) => {
          safeSend(ws, { type: 'connect-error', id, message: err.message || 'Socket error' });
          socket.destroy();
          tunnels.delete(id);
        });

        socket.on('end', () => {
          safeSend(ws, { type: 'connect-end', id });
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
          safeSend(ws, { type: 'connect-error', id, message: 'Unknown tunnel' });
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
  });

  return { ws };
}

module.exports = { startLan };
