const WebSocket = require('ws');
const { safeSend, createLogger } = require('./common');

function startServer({ port = 8080, host = '0.0.0.0' } = {}) {
  const log = createLogger('server');
  const wss = new WebSocket.Server({ port, host });
  const sessions = new Map();
  const connectionMeta = new Map();

  function getSession(session) {
    if (!sessions.has(session)) {
      sessions.set(session, {
        lan: null,
        proxies: new Set(),
        requests: new Map(), // id -> proxy ws
        tunnels: new Map(), // id -> proxy ws
      });
    }
    return sessions.get(session);
  }

  function cleanupConnection(ws) {
    const meta = connectionMeta.get(ws);
    if (!meta) return;
    const state = sessions.get(meta.session);
    if (!state) return;

    if (meta.role === 'lan') {
      state.lan = null;
      for (const [id, proxyWs] of state.requests.entries()) {
        safeSend(proxyWs, { type: 'http-response', id, error: 'LAN disconnected' });
      }
      state.requests.clear();

      for (const [id, proxyWs] of state.tunnels.entries()) {
        safeSend(proxyWs, { type: 'connect-error', id, message: 'LAN disconnected' });
      }
      state.tunnels.clear();
    } else if (meta.role === 'proxy') {
      state.proxies.delete(ws);
      for (const [id, proxyWs] of state.requests.entries()) {
        if (proxyWs === ws) state.requests.delete(id);
      }
      for (const [id, proxyWs] of state.tunnels.entries()) {
        if (proxyWs === ws) {
          state.tunnels.delete(id);
          if (state.lan) safeSend(state.lan, { type: 'connect-end', id });
        }
      }
    }
    connectionMeta.delete(ws);
  }

  function handleHello(ws, payload) {
    const { session, role } = payload;
    if (!session || !role || !['lan', 'proxy'].includes(role)) {
      safeSend(ws, { type: 'error', message: 'Invalid hello payload' });
      return;
    }

    const state = getSession(session);
    if (role === 'lan') {
      if (state.lan && state.lan !== ws) {
        try {
          state.lan.close(1000, 'Replaced by new LAN connection');
        } catch (_) {
          // ignore
        }
      }
      state.lan = ws;
      log(`LAN registered for session ${session}`);
    } else {
      state.proxies.add(ws);
      log(`Proxy connected for session ${session}`);
    }
    connectionMeta.set(ws, { session, role });
    safeSend(ws, { type: 'hello-ack', role, session });
  }

  function routeToLan(session, payload, ws) {
    const state = getSession(session);
    if (!state.lan || state.lan.readyState !== WebSocket.OPEN) {
      if (payload.type === 'http-request') {
        safeSend(ws, { type: 'http-response', id: payload.id, error: 'No LAN available for session' });
      } else if (payload.type && payload.type.startsWith('connect')) {
        safeSend(ws, { type: 'connect-error', id: payload.id, message: 'No LAN available for session' });
      } else {
        safeSend(ws, { type: 'error', message: 'No LAN available for session' });
      }
      return;
    }

    if (payload.type === 'http-request') {
      state.requests.set(payload.id, ws);
    }
    if (payload.type === 'connect-start') {
      state.tunnels.set(payload.id, ws);
    }

    safeSend(state.lan, { ...payload, session });
  }

  function handleProxyMessage(ws, payload) {
    const meta = connectionMeta.get(ws);
    if (!meta) {
      safeSend(ws, { type: 'error', message: 'Handshake required' });
      return;
    }
    switch (payload.type) {
      case 'http-request':
      case 'connect-start':
      case 'connect-data':
      case 'connect-end':
        routeToLan(meta.session, payload, ws);
        break;
      default:
        safeSend(ws, { type: 'error', message: `Unknown message type from proxy: ${payload.type}` });
    }
  }

  function handleLanMessage(ws, payload) {
    const meta = connectionMeta.get(ws);
    if (!meta) {
      safeSend(ws, { type: 'error', message: 'Handshake required' });
      return;
    }
    const state = getSession(meta.session);
    switch (payload.type) {
      case 'http-response': {
        const proxyWs = state.requests.get(payload.id);
        if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
          safeSend(proxyWs, payload);
        }
        state.requests.delete(payload.id);
        break;
      }
      case 'connect-ack':
      case 'connect-error':
      case 'connect-data':
      case 'connect-end': {
        const proxyWs = state.tunnels.get(payload.id);
        if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
          safeSend(proxyWs, payload);
        }
        if (payload.type === 'connect-error' || payload.type === 'connect-end') {
          state.tunnels.delete(payload.id);
        }
        break;
      }
      default:
        safeSend(ws, { type: 'error', message: `Unknown message type from LAN: ${payload.type}` });
    }
  }

  function handleMessage(ws, data) {
    let payload;
    try {
      payload = JSON.parse(data.toString());
    } catch (err) {
      safeSend(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }
    if (payload.type === 'hello') {
      handleHello(ws, payload);
      return;
    }
    const meta = connectionMeta.get(ws);
    if (!meta) {
      safeSend(ws, { type: 'error', message: 'Handshake required' });
      return;
    }
    if (meta.role === 'proxy') {
      handleProxyMessage(ws, payload);
    } else {
      handleLanMessage(ws, payload);
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data) => handleMessage(ws, data));
    ws.on('close', () => cleanupConnection(ws));
    ws.on('error', (err) => {
      log('WebSocket error', err.message || err);
      cleanupConnection(ws);
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

  log(`listening on ws://${host}:${port}`);
  return { wss, stop: () => wss.close() };
}

module.exports = { startServer };
