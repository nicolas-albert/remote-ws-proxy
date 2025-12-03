const { io } = require('socket.io-client');
const net = require('net');
const tls = require('tls');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const {
  decodeBody,
  encodeBody,
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

async function performHttpRequest(request) {
  const { method, url, headers = {}, bodyBase64 } = request;
  const body = decodeBody(bodyBase64);
  const res = await fetch(url, {
    method,
    headers: sanitizeHeaders(headers),
    body: body.length ? body : undefined,
    redirect: 'manual',
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: typeof res.headers?.raw === 'function' ? res.headers.raw() : Object.fromEntries(res.headers.entries()),
    bodyBase64: encodeBody(buffer),
  };
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

function chooseTransports(mode) {
  if (mode === 'ws') return ['websocket'];
  if (mode === 'http') return ['polling'];
  return ['websocket', 'polling']; // auto: try WS first, fallback to polling
}

function startLan({ serverUrl, session, proxyUrl, tunnelProxy, insecure = false, transport = 'auto', debug = false }) {
  if (insecure && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }
  const { httpUrl, session: resolvedSession } = parseServerTarget(serverUrl, session);
  const base = new URL(httpUrl);
  const ioUrl = base.origin;

  const log = createLogger(`lan:${resolvedSession}`);
  const dlog = createDebugLogger(debug, `lan:${resolvedSession}:debug`);
  const agentUrl = proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const agent = buildProxyAgent(agentUrl, insecure);
  const tunnelProxyUrl = tunnelProxy === true ? agentUrl : tunnelProxy;
  const agentLabel = agentUrl ? ` via proxy ${agentUrl}` : '';

  const tunnels = new Map(); // id -> net.Socket
  const outbox = [];
  let socket;

  function send(msg) {
    if (socket && socket.connected) {
      socket.emit('msg', msg);
    } else {
      outbox.push(msg);
    }
  }

  function flush() {
    if (!socket || !socket.connected) return;
    while (outbox.length) {
      socket.emit('msg', outbox.shift());
    }
  }

  function handleMessage(payload) {
    switch (payload.type) {
      case 'hello-ack':
        return;
      case 'http-request': {
        const { id, request } = payload;
        performHttpRequest(request)
          .then((result) => send({ type: 'http-response', id, ...result }))
          .catch((err) => {
            log(`Request failed for ${request?.url || 'unknown'}: ${err.message || err}`);
            send({ type: 'http-response', id, error: err.message || 'Request failed' });
          });
        break;
      }
      case 'connect-start': {
        const { id, host, port } = payload;
        if (!host || !port) {
          send({ type: 'connect-error', id, message: 'Invalid host/port' });
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
          .then((sock) => {
            send({ type: 'connect-ack', id });
            tunnels.set(id, sock);

            sock.on('data', (chunk) => {
              send({ type: 'connect-data', id, dataBase64: encodeBody(chunk) });
            });

            sock.on('error', (err) => {
              send({ type: 'connect-error', id, message: err.message || 'Socket error' });
              sock.destroy();
              tunnels.delete(id);
            });

            sock.on('end', () => {
              send({ type: 'connect-end', id });
              sock.destroy();
              tunnels.delete(id);
            });
          })
          .catch((err) => {
            send({ type: 'connect-error', id, message: err.message || 'Socket error' });
          });
        break;
      }
      case 'connect-data': {
        const { id, dataBase64 } = payload;
        const sock = tunnels.get(id);
        if (sock) {
          sock.write(decodeBody(dataBase64));
        } else {
          send({ type: 'connect-error', id, message: 'Unknown tunnel' });
        }
        break;
      }
      case 'connect-end': {
        const { id } = payload;
        const sock = tunnels.get(id);
        if (sock) {
          sock.end();
          tunnels.delete(id);
        }
        break;
      }
      default:
        log(`Unsupported message type: ${payload.type}`);
    }
  }

  const transports = chooseTransports(transport);

  socket = io(ioUrl, {
    transports,
    forceNew: true,
    reconnection: true,
    query: { session: resolvedSession, role: 'lan', protocolVersion: PROTOCOL_VERSION },
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

  // Log when polling upgrades to websocket
  socket.io.engine.on('upgrade', () => {
    const t = socket?.io?.engine?.transport?.name;
    log(`socket.io upgraded transport=${t || 'unknown'}${agentLabel}`);
  });

  socket.on('msg', (payload) => handleMessage(payload));

  socket.on('disconnect', () => {
    log('connection closed');
    tunnels.forEach((s) => s.destroy());
    tunnels.clear();
  });

  socket.on('error', (err) => {
    log(`socket error: ${err.message || err}`);
  });

  return { socket };
}

module.exports = { startLan };
