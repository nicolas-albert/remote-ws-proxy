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
  createDebugLogger,
  parseServerTarget,
  PROTOCOL_VERSION,
  shouldResendHello,
} = require('./common');

function buildProxyAgent(proxyUrl, insecure, targetProtocol) {
  if (!proxyUrl) return null;
  const url = new URL(proxyUrl);
  const opts = { rejectUnauthorized: !insecure, keepAlive: true };
  // For HTTPS targets, use HttpsProxyAgent even if the proxy is HTTP to ensure CONNECT is used.
  if (targetProtocol === 'https:') return new HttpsProxyAgent(url, opts);
  return url.protocol === 'http:' ? new HttpProxyAgent(url, opts) : new HttpsProxyAgent(url, opts);
}

function startProxy({
  serverUrl,
  session,
  port = 3128,
  host = '127.0.0.1',
  proxyUrl,
  insecure = false,
  transport = 'ws',
  debug = false,
}) {
  const { wsUrl, httpUrl, session: resolvedSession } = parseServerTarget(serverUrl, session);
  const log = createLogger(`proxy:${resolvedSession}`);
  const dlog = createDebugLogger(debug, `proxy:${resolvedSession}:debug`);
  const agentUrl = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const targetProtocol = new URL(httpUrl).protocol;
  const agent = buildProxyAgent(agentUrl, insecure, targetProtocol);
  const pendingHttp = new Map(); // id -> {res, timer}
  const tunnels = new Map(); // id -> {clientSocket, acked, queue}
  let ws;
  let sendToServer = () => {};
  let sendHttp = null;
  let currentTransport = transport;

function ensureConnected(responder) {
  if ((currentTransport === 'ws' || currentTransport === 'auto') && ws && ws.readyState !== WebSocket.OPEN) return false;
  if (currentTransport === 'http') return true;
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
    if ((currentTransport === 'http' || currentTransport === 'auto') && sendHttp) {
      return sendHttp(msg);
    }
    if (ws) safeSend(ws, msg);
  };

  function runHttpMode() {
    const httpBase = new URL(httpUrl);
    const baseHttp = httpBase.origin; // server root (no session path)

    sendHttp = async function (message) {
      const url = `${baseHttp}/api/tunnel/${encodeURIComponent(resolvedSession)}/send`;
      const body = JSON.stringify({ role: 'proxy', message });
      dlog('HTTP send', url, body.slice(0, 200), 'curl:', `curl -k${agent ? ' --proxy ' + agentUrl : ''} -H "content-type: application/json" -d '${body}' ${url}`);
      await fetchHttp(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        agent,
      });
    };

    async function pollOnce() {
      try {
        const url = `${baseHttp}/api/tunnel/${encodeURIComponent(resolvedSession)}/recv?role=proxy`;
        dlog('HTTP recv', url, 'curl:', `curl -k${agent ? ' --proxy ' + agentUrl : ''} -i ${url}`);
        const res = await fetchHttp(url, {
          method: 'GET',
          agent,
        });
        dlog('HTTP recv status', res.status, res.statusText);
        if (res.status === 204) return;
        if (!res.ok) {
          let bodyText = '';
          try {
            bodyText = await res.text();
          } catch (_) {}
          log(`HTTP recv failed: ${res.status}${bodyText ? ` body: ${bodyText.slice(0, 200)}` : ''}`);
          if (shouldResendHello(res.status)) {
            dlog('Resending hello due to status', res.status);
            sendHttp({ type: 'hello', role: 'proxy', session: resolvedSession, protocolVersion: PROTOCOL_VERSION }).catch(() => {});
          }
          await new Promise((r) => setTimeout(r, 500));
          return;
        }
        const text = await res.text();
        if (!text) return;
        const payload = JSON.parse(text);
        handleServerMessage(payload, sendHttp);
      } catch (err) {
        log(`HTTP poll error: ${err.message || err}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const parallelPolls = 3;
    const startPollers = () => {
      for (let i = 0; i < parallelPolls; i += 1) {
        (async function loop() {
          while (true) {
            await pollOnce();
          }
        })();
      }
    };

    sendHttp({ type: 'hello', role: 'proxy', session: resolvedSession, protocolVersion: PROTOCOL_VERSION }).catch((err) =>
      log(`Hello failed: ${err.message || err}`)
    );
    startPollers();
    currentTransport = 'http';
    log(`connected via HTTP tunnel to ${baseHttp}${agentUrl ? ` through proxy ${agentUrl}` : ''}`);
    return { server, transport: 'http' };
  }

  function runWsMode({ allowFallback } = {}) {
    const wsOptions = {};
    if (agent) wsOptions.agent = agent;
    if (insecure) wsOptions.rejectUnauthorized = false;
    ws = new WebSocket(wsUrl, wsOptions);
    let opened = false;
    currentTransport = 'ws';

    ws.on('open', () => {
      opened = true;
      safeSend(ws, { type: 'hello', role: 'proxy', session: resolvedSession, protocolVersion: PROTOCOL_VERSION });
      log(`connected to server ${wsUrl}${agentUrl ? ` via proxy ${agentUrl}` : ''}`);
    });

    const fallback = () => {
      if (!allowFallback) return;
      log('WebSocket failed, falling back to HTTP transport');
      ws.removeAllListeners();
      try {
        ws.close();
      } catch (_) {}
      runHttpMode();
    };

    ws.on('close', () => {
      log('server connection closed');
      cleanupPendingWithMessage('Server connection closed');
      if (!opened && allowFallback) fallback();
    });

    ws.on('error', (err) => {
      log(`WebSocket error: ${err.message || err}`);
      if (!opened && allowFallback) fallback();
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

  if (transport === 'http') {
    return runHttpMode();
  }
  if (transport === 'auto') {
    return runWsMode({ allowFallback: true });
  }
  return runWsMode({ allowFallback: false });
}

module.exports = { startProxy };
