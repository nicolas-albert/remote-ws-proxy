const http = require('http');
const net = require('net');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const fetchHttp = require('node-fetch');
const {
  encodeBody,
  decodeBody,
  collectRequestBody,
  sanitizeHeaders,
  safeSend,
  createLogger,
  parseServerTarget,
} = require('./common');

function buildProxyAgent(proxyUrl, insecure) {
  if (!proxyUrl) return null;
  const url = new URL(proxyUrl);
  const opts = { rejectUnauthorized: !insecure };
  if (url.protocol === 'http:') return new HttpProxyAgent(url, opts);
  return new HttpsProxyAgent(url, opts);
}

function startProxy({ serverUrl, session, port = 3128, host = '127.0.0.1', proxyUrl, insecure = false, transport = 'ws' }) {
  const { wsUrl, httpUrl, session: resolvedSession } = parseServerTarget(serverUrl, session);
  const log = createLogger(`proxy:${resolvedSession}`);
  const agentUrl = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const agent = buildProxyAgent(agentUrl, insecure);
  const pendingHttp = new Map(); // id -> {res, timer}
  const tunnels = new Map(); // id -> {clientSocket, acked, queue}
  let ws;
  let sendToServer = () => {};

  function ensureConnected(responder) {
    if (transport === 'ws' && ws.readyState !== WebSocket.OPEN) return false;
    if (transport === 'http') return true;
    return true;
  }

  function cleanupPendingWithMessage(message) {
    pendingHttp.forEach(({ res, timer }) => {
      clearTimeout(timer);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end(message);
    });
    pendingHttp.clear();

    tunnels.forEach(({ clientSocket }) => {
      try {
        clientSocket.end();
      } catch (_) {
        // ignore
      }
    });
    tunnels.clear();
  }

  function handleServerMessage(payload, sendFn) {
    switch (payload.type) {
      case 'hello-ack':
        return;
      case 'http-response': {
        const entry = pendingHttp.get(payload.id);
        if (!entry) return;
        const { res, timer } = entry;
        clearTimeout(timer);
        pendingHttp.delete(payload.id);

        if (payload.error) {
          log(`Upstream error: ${payload.error}`);
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
          res.end(payload.error);
          return;
        }
        const headers = payload.headers || {};
        if (!res.headersSent) {
          res.writeHead(payload.status || 500, headers);
        }
        res.end(decodeBody(payload.bodyBase64));
        break;
      }
      case 'connect-ack': {
        const tunnel = tunnels.get(payload.id);
        if (!tunnel) break;
        const { clientSocket, queue, head } = tunnel;
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        tunnel.acked = true;
        if (head && head.length) {
          sendFn({ type: 'connect-data', id: payload.id, dataBase64: encodeBody(head) });
        }
        while (queue.length) {
          const chunk = queue.shift();
          sendFn({ type: 'connect-data', id: payload.id, dataBase64: encodeBody(chunk) });
        }
        break;
      }
      case 'connect-error': {
        const tunnel = tunnels.get(payload.id);
        if (tunnel) {
          tunnel.clientSocket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${payload.message?.length || 0}\r\n\r\n${payload.message || ''}`);
          tunnel.clientSocket.end();
          tunnels.delete(payload.id);
        }
        break;
      }
      case 'connect-data': {
        const tunnel = tunnels.get(payload.id);
        if (tunnel) {
          tunnel.clientSocket.write(decodeBody(payload.dataBase64));
        }
        break;
      }
      case 'connect-end': {
        const tunnel = tunnels.get(payload.id);
        if (tunnel) {
          tunnel.clientSocket.end();
          tunnels.delete(payload.id);
        }
        break;
      }
      default:
        log(`Unsupported message type: ${payload.type}`);
    }
  }

  async function handleHttpRequest(req, res) {
    if (!ensureConnected()) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('WebSocket not connected');
      return;
    }
    const id = randomUUID();
    let body = Buffer.alloc(0);
    try {
      body = await collectRequestBody(req);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Failed to read request body');
      return;
    }

    const headers = sanitizeHeaders(req.headers);

    // Build absolute URL if the client sent only a path (some proxy clients do that for ping checks)
    let targetUrl = req.url;
    if (!/^https?:\/\//i.test(targetUrl)) {
      const hostHeader = req.headers.host;
      if (!hostHeader) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Missing Host header');
        return;
      }
      targetUrl = `http://${hostHeader}${targetUrl}`;
    }

    const payload = {
      type: 'http-request',
      id,
      session,
      request: {
        method: req.method,
        url: targetUrl,
        headers,
        bodyBase64: encodeBody(body),
      },
    };
    const timer = setTimeout(() => {
      pendingHttp.delete(id);
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'text/plain' });
      }
      res.end('Gateway Timeout');
    }, 30000);

    pendingHttp.set(id, { res, timer });
    sendToServer(payload);
  }

  function handleConnect(req, clientSocket, head) {
    if (!ensureConnected()) {
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const [host, port] = req.url.split(':');
    const id = randomUUID();
    const tunnel = { clientSocket, acked: false, queue: [], head };
    tunnels.set(id, tunnel);
    sendToServer({ type: 'connect-start', id, session, host, port });

    clientSocket.on('data', (chunk) => {
      if (!tunnel.acked) {
        tunnel.queue.push(chunk);
        return;
      }
      sendToServer({ type: 'connect-data', id, dataBase64: encodeBody(chunk) });
    });

    clientSocket.on('end', () => {
      sendToServer({ type: 'connect-end', id });
      tunnels.delete(id);
    });

    clientSocket.on('error', () => {
      sendToServer({ type: 'connect-end', id });
      tunnels.delete(id);
    });
  }

  const server = http.createServer(handleHttpRequest);
  server.on('connect', handleConnect);

  server.listen(port, host, () => {
    log(`HTTP proxy listening on http://${host}:${port}`);
  });

  sendToServer = (msg) => {
    if (transport === 'http') {
      return sendHttp(msg);
    }
    safeSend(ws, msg);
  };

  if (transport === 'http') {
    const httpBase = new URL(httpUrl);
    const baseHttp = httpBase.origin; // server root (no session path)

    async function sendHttp(message) {
      await fetchHttp(`${baseHttp}/api/tunnel/${encodeURIComponent(resolvedSession)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'proxy', message }),
        agent,
      });
    }

    async function poll() {
      for (;;) {
        try {
          const res = await fetchHttp(`${baseHttp}/api/tunnel/${encodeURIComponent(resolvedSession)}/recv?role=proxy`, {
            method: 'GET',
            agent,
          });
          if (res.status === 204) continue;
          if (!res.ok) {
            log(`HTTP recv failed: ${res.status}`);
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          const text = await res.text();
          if (!text) continue;
          const payload = JSON.parse(text);
          handleServerMessage(payload, sendHttp);
        } catch (err) {
          log(`HTTP poll error: ${err.message || err}`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    sendHttp({ type: 'hello', role: 'proxy', session: resolvedSession }).catch((err) =>
      log(`Hello failed: ${err.message || err}`)
    );
    poll();
    log(`connected via HTTP tunnel to ${baseHttp}${agentUrl ? ` through proxy ${agentUrl}` : ''}`);
    return { server, transport: 'http' };
  }

  const wsOptions = {};
  if (agent) wsOptions.agent = agent;
  if (insecure) wsOptions.rejectUnauthorized = false;
  ws = new WebSocket(wsUrl, wsOptions);

  ws.on('open', () => {
    safeSend(ws, { type: 'hello', role: 'proxy', session: resolvedSession });
    log(`connected to server ${wsUrl}${agentUrl ? ` via proxy ${agentUrl}` : ''}`);
  });

  ws.on('close', () => {
    log('server connection closed');
    cleanupPendingWithMessage('Server connection closed');
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
    handleServerMessage(payload, (p) => safeSend(ws, p));
  });

  return { ws, server };
}

module.exports = { startProxy };
