const WebSocket = require('ws');
const net = require('net');
const https = require('https');
const tls = require('tls');
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
  PROTOCOL_VERSION,
  shouldResendHello,
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

function buildProxyAgent(proxyUrl, insecure, targetProtocol) {
  if (!proxyUrl) return null;
  const url = new URL(proxyUrl);
  const opts = { rejectUnauthorized: !insecure, keepAlive: true };
  // For HTTPS targets, use HttpsProxyAgent even if the proxy is HTTP to ensure CONNECT is used.
  if (targetProtocol === 'https:') return new HttpsProxyAgent(url, opts);
  return url.protocol === 'http:' ? new HttpProxyAgent(url, opts) : new HttpsProxyAgent(url, opts);
}

function buildDirectAgent(targetProtocol, insecure) {
  const opts = { keepAlive: true };
  if (insecure) opts.rejectUnauthorized = false;
  if (targetProtocol === 'http:') {
    const http = require('http');
    return new http.Agent(opts);
  }
  return new https.Agent(opts);
}

async function connectThroughProxy(proxyUrl, targetHost, targetPort, insecure) {
  const url = new URL(proxyUrl);
  const isHttpsProxy = url.protocol === 'https:';
  const connectOpts = {
    host: url.hostname,
    port: url.port || (isHttpsProxy ? 443 : 80),
    rejectUnauthorized: !insecure,
    servername: url.hostname,
  };
  const socket = isHttpsProxy ? tls.connect(connectOpts) : net.connect(connectOpts);

  return await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('Proxy socket closed')));
    socket.once('connect', () => {
      const req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`;
      socket.write(req);
    });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        const [statusLine] = buffer.split('\r\n');
        const match = statusLine.match(/HTTP\/1\.[01] (\d{3})/);
        const code = match ? Number(match[1]) : 0;
        if (code === 200) {
          socket.removeAllListeners('data');
          socket.removeAllListeners('error');
          resolve(socket);
        } else {
          reject(new Error(`Proxy CONNECT failed with status ${code}`));
        }
      }
    });
  });
}

function startLan({ serverUrl, session, proxyUrl, tunnelProxy, insecure = false, transport = 'ws', debug = false }) {
  if (insecure && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  const { wsUrl, httpUrl, session: resolvedSession } = parseServerTarget(serverUrl, session);
  const log = createLogger(`lan:${resolvedSession}`);
  const dlog = createDebugLogger(debug, `lan:${resolvedSession}:debug`);
  const agentUrl = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const targetProtocol = new URL(httpUrl).protocol;
  const proxyAgent = buildProxyAgent(agentUrl, insecure, targetProtocol);
  const directAgent = buildDirectAgent(targetProtocol, insecure);
  const fetchAgent = proxyAgent || directAgent;

  const tunnels = new Map(); // id -> net.Socket
  const tunnelProxyUrl = tunnelProxy === true ? agentUrl : tunnelProxy;
  let sendFn = () => {};

  function handleMessage(payload, sender) {
    switch (payload.type) {
      case 'hello-ack':
        return;
      case 'http-request': {
        const { id, request } = payload;
        performHttpRequest(request)
          .then((result) => sender({ type: 'http-response', id, ...result }))
          .catch((err) => {
            log(`Request failed for ${request?.url || 'unknown'}: ${err.message || err}`);
            sender({ type: 'http-response', id, error: err.message || 'Request failed' });
          });
        break;
      }
      case 'connect-start': {
        const { id, host, port } = payload;
        if (!host || !port) {
          sender({ type: 'connect-error', id, message: 'Invalid host/port' });
          break;
        }
        const connectSocket = async () => {
          if (tunnelProxyUrl) {
            dlog('CONNECT via tunnel-proxy', tunnelProxyUrl, 'to', `${host}:${port}`);
            return connectThroughProxy(tunnelProxyUrl, host, Number(port), insecure);
          }
          return net.createConnection({ host, port: Number(port) });
        };
        connectSocket()
          .then((socket) => {
            sender({ type: 'connect-ack', id });
            tunnels.set(id, socket);

            socket.on('data', (chunk) => {
              sender({ type: 'connect-data', id, dataBase64: encodeBody(chunk) });
            });

            socket.on('error', (err) => {
              sender({ type: 'connect-error', id, message: err.message || 'Socket error' });
              socket.destroy();
              tunnels.delete(id);
            });

            socket.on('end', () => {
              sender({ type: 'connect-end', id });
              socket.destroy();
              tunnels.delete(id);
            });
          })
          .catch((err) => {
            sender({ type: 'connect-error', id, message: err.message || 'Socket error' });
          });

        break;
      }
      case 'connect-data': {
        const { id, dataBase64 } = payload;
        const socket = tunnels.get(id);
        if (socket) {
          socket.write(decodeBody(dataBase64));
        } else {
          sender({ type: 'connect-error', id, message: 'Unknown tunnel' });
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

  function runHttpMode() {
    const httpBase = new URL(httpUrl);
    const baseHttp = httpBase.origin; // server root (no session path)
    const outbox = [];
    sendFn = (message) => outbox.push(message);
    const BATCH_TIME_MS = 15;
    const BATCH_BYTES = 32 * 1024;
    const BATCH_COUNT = 64;

    async function startStream() {
      while (true) {
        try {
          const url = `${baseHttp}/api/stream/${encodeURIComponent(resolvedSession)}?role=lan`;
          dlog('HTTP stream', url);
          const res = await fetchHttp(url, { method: 'GET', agent: fetchAgent });
          if (!res.ok) {
            log(`HTTP stream failed: ${res.status}`);
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          const reader = res.body;
          let buffer = '';
          for await (const chunk of reader) {
            buffer += chunk.toString();
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx).trim();
              buffer = buffer.slice(idx + 1);
              if (!line) continue;
              try {
                const payload = JSON.parse(line);
                const items = Array.isArray(payload) ? payload : [payload];
                for (const item of items) handleMessage(item, (msg) => outbox.push(msg));
              } catch (err) {
                log(`Stream parse error: ${err.message || err}`);
              }
            }
          }
        } catch (err) {
          log(`HTTP stream error: ${err.message || err}`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    const idleDelayMs = 200;

    function buildBatch() {
      if (!outbox.length) return null;
      const first = outbox.shift();
      const batch = [first];
      let size = Buffer.byteLength(JSON.stringify(first));
      const start = Date.now();
      while (outbox.length && batch.length < BATCH_COUNT && Date.now() - start < BATCH_TIME_MS) {
        const next = outbox[0];
        const nextSize = Buffer.byteLength(JSON.stringify(next));
        if (size + nextSize > BATCH_BYTES) break;
        batch.push(outbox.shift());
        size += nextSize;
      }
      return batch;
    }

    async function loop() {
      while (true) {
        const batch = buildBatch();
        if (!batch) {
          await new Promise((r) => setTimeout(r, idleDelayMs));
          continue;
        }
        const body = { role: 'lan', message: batch.length === 1 ? batch[0] : batch };
        try {
          const url = `${baseHttp}/api/send/${encodeURIComponent(resolvedSession)}?role=lan`;
          dlog('HTTP send', url, batch.length === 1 ? JSON.stringify(body.message) : `batch x${batch.length}`);
          const res = await fetchHttp(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            agent: fetchAgent,
          });
          if (!res.ok) {
            log(`HTTP send failed: ${res.status} ${res.statusText || ''}`.trim());
          }
        } catch (err) {
          log(`HTTP send error: ${err.message || err}`);
          // push back the batch to retry
          while (batch.length) outbox.unshift(batch.pop());
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    outbox.push({ type: 'hello', role: 'lan', session: resolvedSession, protocolVersion: PROTOCOL_VERSION });
    loop();
    startStream();
    log(`using HTTP stream/send to ${baseHttp}${agentUrl ? ` via proxy ${agentUrl}` : ''}`);
    return { transport: 'http' };
  }

  function runWsMode({ allowFallback } = {}) {
    const wsOptions = {};
    if (proxyAgent) wsOptions.agent = proxyAgent;
    if (insecure) wsOptions.rejectUnauthorized = false;
    const ws = new WebSocket(wsUrl, wsOptions);
    let opened = false;

    sendFn = (p) => safeSend(ws, p);

    ws.on('open', () => {
      opened = true;
      safeSend(ws, { type: 'hello', role: 'lan', session: resolvedSession, protocolVersion: PROTOCOL_VERSION });
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
      if (!opened && allowFallback) {
        fallback();
        return;
      }
      log('connection closed');
      tunnels.forEach((socket) => socket.destroy());
      tunnels.clear();
    });

    ws.on('error', (err) => {
      log(`WebSocket error: ${err.message || err}`);
      if (!opened && allowFallback) {
        fallback();
      }
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

  if (transport === 'http') {
    return runHttpMode();
  }
  if (transport === 'auto') {
    return runWsMode({ allowFallback: true });
  }
  return runWsMode({ allowFallback: false });
}

module.exports = { startLan };
