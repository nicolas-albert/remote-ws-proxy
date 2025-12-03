const http = require('http');
const net = require('net');
const { randomUUID } = require('crypto');
const { io } = require('socket.io-client');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const {
  encodeBody,
  decodeBody,
  collectRequestBody,
  sanitizeHeaders,
  createLogger,
  createDebugLogger,
  parseServerTarget,
  PROTOCOL_VERSION,
} = require('./common');

function buildProxyAgent(proxyUrl, insecure) {
  if (!proxyUrl) return null;
  const url = new URL(proxyUrl);
  const opts = { rejectUnauthorized: !insecure, keepAlive: true };
  return url.protocol === 'http:' ? new HttpProxyAgent(url, opts) : new HttpsProxyAgent(url, opts);
}

function chooseTransports(mode) {
  if (mode === 'ws') return ['websocket'];
  if (mode === 'http') return ['polling'];
  return ['websocket', 'polling']; // auto: try WS first, fallback to polling
}

function startProxy({
  serverUrl,
  session,
  port = 3128,
  host = '127.0.0.1',
  proxyUrl,
  insecure = false,
  transport = 'auto',
  debug = false,
}) {
  if (insecure && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const { httpUrl, session: resolvedSession } = parseServerTarget(serverUrl, session);
  const base = new URL(httpUrl);
  const ioUrl = base.origin;

  const log = createLogger(`proxy:${resolvedSession}`);
  const dlog = createDebugLogger(debug, `proxy:${resolvedSession}:debug`);
  const agentUrl = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const agent = buildProxyAgent(agentUrl, insecure);
  const agentLabel = agentUrl ? ` via proxy ${agentUrl}` : '';

  const pendingHttp = new Map(); // id -> {res, timer}
  const tunnels = new Map(); // id -> {clientSocket, acked, queue, head}
  const outbox = [];
  let socket;

  function sendToServer(message) {
    if (socket && socket.connected) {
      socket.emit('msg', message);
    } else {
      outbox.push(message);
    }
  }

  function flush() {
    if (!socket || !socket.connected) return;
    while (outbox.length) socket.emit('msg', outbox.shift());
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

  function handleServerMessage(payload) {
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
          sendToServer({ type: 'connect-data', id: payload.id, dataBase64: encodeBody(head) });
        }
        while (queue.length) {
          const chunk = queue.shift();
          sendToServer({ type: 'connect-data', id: payload.id, dataBase64: encodeBody(chunk) });
        }
        break;
      }
      case 'connect-error': {
        const tunnel = tunnels.get(payload.id);
        if (tunnel) {
          tunnel.clientSocket.write(
            `HTTP/1.1 502 Bad Gateway\r\nContent-Length: ${payload.message?.length || 0}\r\n\r\n${payload.message || ''}`,
          );
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
    if (!socket || !socket.connected) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Server not connected');
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
      session: resolvedSession,
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
    if (!socket || !socket.connected) {
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const [host, port] = req.url.split(':');
    const id = randomUUID();
    const tunnel = { clientSocket, acked: false, queue: [], head };
    tunnels.set(id, tunnel);
    sendToServer({ type: 'connect-start', id, session: resolvedSession, host, port });

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

  const transports = chooseTransports(transport);
  if (debug) process.env.DEBUG = 'socket.io-client:*';

  socket = io(ioUrl, {
    transports,
    forceNew: true,
    reconnection: true,
    query: { session: resolvedSession, role: 'proxy', protocolVersion: PROTOCOL_VERSION },
    transportOptions: {
      polling: { agent, rejectUnauthorized: !insecure },
      websocket: { agent, rejectUnauthorized: !insecure },
    },
  });

  socket.on('connect', () => {
    const t = socket?.io?.engine?.transport?.name;
    log(`connected to server ${ioUrl} (transport=${t || 'unknown'}${agentLabel})`);
    flush();
  });

  socket.io.engine.on('upgrade', () => {
    const t = socket?.io?.engine?.transport?.name;
    log(`socket.io upgraded transport=${t || 'unknown'}${agentLabel}`);
  });

  socket.on('msg', (payload) => handleServerMessage(payload));

  socket.on('disconnect', () => {
    log('server connection closed');
    cleanupPendingWithMessage('Server connection closed');
  });

  socket.on('error', (err) => {
    log(`socket error: ${err.message || err}`);
  });

  return { socket, server };
}

module.exports = { startProxy };
