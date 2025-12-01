const http = require('http');
const WebSocket = require('ws');
const { safeSend, createLogger } = require('./common');

function createChannel() {
  return {
    ws: null,
    queue: [],
    pendingRes: null,
    pendingTimer: null,
  };
}

function respondChannel(channel, payload) {
  if (channel.ws && channel.ws.readyState === WebSocket.OPEN) {
    safeSend(channel.ws, payload);
    return true;
  }
  if (channel.pendingRes) {
    channel.pendingRes.writeHead(200, { 'content-type': 'application/json' });
    channel.pendingRes.end(JSON.stringify(payload));
    clearTimeout(channel.pendingTimer);
    channel.pendingRes = null;
    channel.pendingTimer = null;
    return true;
  }
  channel.queue.push(payload);
  return false;
}

function drainChannel(channel, res) {
  if (channel.queue.length > 0) {
    const payload = channel.queue.shift();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }
  channel.pendingRes = res;
  channel.pendingTimer = setTimeout(() => {
    if (channel.pendingRes) {
      channel.pendingRes.writeHead(204);
      channel.pendingRes.end();
      channel.pendingRes = null;
      channel.pendingTimer = null;
    }
  }, 30000);
}

function startServer({ port = 8080, host = '0.0.0.0' } = {}) {
  const log = createLogger('server');
  const sessions = new Map();
  const connectionMeta = new Map(); // ws -> { session, role }

  function getSession(session) {
    if (!sessions.has(session)) {
      sessions.set(session, {
        lan: createChannel(),
        proxy: createChannel(),
        requests: new Map(),
        tunnels: new Map(),
      });
    }
    return sessions.get(session);
  }

  function cleanupWs(ws) {
    const meta = connectionMeta.get(ws);
    if (!meta) return;
    const state = sessions.get(meta.session);
    if (!state) return;
    const channel = state[meta.role];
    if (channel && channel.ws === ws) {
      channel.ws = null;
    }
    if (meta.role === 'lan') {
      for (const [id, srcRole] of state.requests.entries()) {
        if (srcRole === 'proxy') respondChannel(state.proxy, { type: 'http-response', id, error: 'LAN disconnected' });
      }
      state.requests.clear();
      for (const [id, srcRole] of state.tunnels.entries()) {
        if (srcRole === 'proxy') respondChannel(state.proxy, { type: 'connect-error', id, message: 'LAN disconnected' });
      }
      state.tunnels.clear();
    } else if (meta.role === 'proxy') {
      for (const [id, srcRole] of state.requests.entries()) {
        if (srcRole === 'proxy') state.requests.delete(id);
      }
      for (const [id, srcRole] of state.tunnels.entries()) {
        if (srcRole === 'proxy') {
          state.tunnels.delete(id);
          respondChannel(state.lan, { type: 'connect-end', id });
        }
      }
    }
    connectionMeta.delete(ws);
  }

  function handleHello(sessionName, role, sender) {
    const state = getSession(sessionName);
    if (role !== 'lan' && role !== 'proxy') {
      return { error: 'Invalid role' };
    }
    const channel = state[role];
    if (sender.ws) {
      if (channel.ws && channel.ws !== sender.ws) {
        try {
          channel.ws.close(1000, 'Replaced by new connection');
        } catch (_) {}
      }
      channel.ws = sender.ws;
    }
    respondChannel(channel, { type: 'hello-ack', role, session: sessionName });
    log(`${role.toUpperCase()} registered for session ${sessionName} via ${sender.ws ? 'ws' : 'http'}`);
    return {};
  }

  function routeFromProxy(sessionName, payload) {
    const state = getSession(sessionName);
    switch (payload.type) {
      case 'http-request':
        state.requests.set(payload.id, 'proxy');
        respondChannel(state.lan, payload);
        break;
      case 'connect-start':
        state.tunnels.set(payload.id, 'proxy');
        respondChannel(state.lan, payload);
        break;
      case 'connect-data':
      case 'connect-end':
        respondChannel(state.lan, payload);
        break;
      default:
        respondChannel(state.proxy, { type: 'error', message: `Unknown message type from proxy: ${payload.type}` });
    }
  }

  function routeFromLan(sessionName, payload) {
    const state = getSession(sessionName);
    switch (payload.type) {
      case 'http-response': {
        const target = state.requests.get(payload.id);
        if (target === 'proxy') respondChannel(state.proxy, payload);
        state.requests.delete(payload.id);
        break;
      }
      case 'connect-ack':
      case 'connect-error':
      case 'connect-data':
      case 'connect-end': {
        const target = state.tunnels.get(payload.id);
        if (target === 'proxy') respondChannel(state.proxy, payload);
        if (payload.type === 'connect-error' || payload.type === 'connect-end') {
          state.tunnels.delete(payload.id);
        }
        break;
      }
      default:
        respondChannel(state.lan, { type: 'error', message: `Unknown message type from LAN: ${payload.type}` });
    }
  }

  function handlePayload(sessionName, role, payload) {
    if (payload.type === 'hello') {
      return handleHello(sessionName, payload.role || role, { ws: null });
    }
    if (role === 'proxy') {
      routeFromProxy(sessionName, payload);
    } else {
      routeFromLan(sessionName, payload);
    }
    return {};
  }

  function handleWsMessage(ws, data) {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch (_) {
      safeSend(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }
    if (payload.type === 'hello') {
      const { session, role } = payload;
      if (!session || !role) {
        safeSend(ws, { type: 'error', message: 'Invalid hello payload' });
        return;
      }
      connectionMeta.set(ws, { session, role });
      handleHello(session, role, { ws });
      return;
    }
    const meta = connectionMeta.get(ws);
    if (!meta) {
      safeSend(ws, { type: 'error', message: 'Handshake required' });
      return;
    }
    if (meta.role === 'proxy') {
      routeFromProxy(meta.session, payload);
    } else {
      routeFromLan(meta.session, payload);
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    const matchRecv = url.pathname.match(/^\/api\/tunnel\/([^/]+)\/recv$/);
    const matchSend = url.pathname.match(/^\/api\/tunnel\/([^/]+)\/send$/);

    if (matchRecv && req.method === 'GET') {
      const sessionName = decodeURIComponent(matchRecv[1]);
      const role = url.searchParams.get('role');
      if (role !== 'lan' && role !== 'proxy') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Invalid role');
        return;
      }
      const state = getSession(sessionName);
      const channel = state[role];
      drainChannel(channel, res);
      return;
    }

    if (matchSend && req.method === 'POST') {
      const sessionName = decodeURIComponent(matchSend[1]);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        } catch (_) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('Invalid JSON');
          return;
        }
        const { role, message } = payload;
        if (role !== 'lan' && role !== 'proxy') {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('Invalid role');
          return;
        }
        if (!message || typeof message !== 'object') {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('Missing message');
          return;
        }
        const result = handlePayload(sessionName, role, message);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
      req.on('error', () => {
        res.writeHead(500);
        res.end();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data) => handleWsMessage(ws, data));
    ws.on('close', () => cleanupWs(ws));
    ws.on('error', (err) => {
      log('WebSocket error', err.message || err);
      cleanupWs(ws);
    });
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  server.listen(port, host, () => log(`listening on ws://${host}:${port} and http://${host}:${port}`));

  return {
    wss,
    server,
    stop: () => {
      clearInterval(heartbeat);
      wss.close();
      server.close();
    },
  };
}

module.exports = { startServer };
