const http = require('http');
const { Server } = require('socket.io');
const { createLogger, PROTOCOL_VERSION } = require('./common');
const { homepage } = require('../package.json');

function createChannel() {
  return { socket: null, queue: [] };
}

function respondChannel(channel, payload) {
  if (channel.socket && channel.socket.connected) {
    channel.socket.emit('msg', payload);
    return true;
  }
  channel.queue.push(payload);
  return false;
}

function startServer({ port = 8080, host = '0.0.0.0' } = {}) {
  const log = createLogger('server');
  const sessions = new Map();
  const connectionMeta = new Map(); // socket.id -> { session, role }

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

  function cleanupSocket(socket) {
    const meta = connectionMeta.get(socket.id);
    if (!meta) return;
    const state = sessions.get(meta.session);
    if (!state) return;
    const channel = state[meta.role];
    if (channel && channel.socket === socket) {
      channel.socket = null;
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
    connectionMeta.delete(socket.id);
  }

  function handleHello(sessionName, role, sender) {
    const state = getSession(sessionName);
    if (role !== 'lan' && role !== 'proxy') {
      return { error: 'Invalid role' };
    }
    if (sender.protocolVersion && sender.protocolVersion !== PROTOCOL_VERSION) {
      return { error: `Protocol mismatch (server ${PROTOCOL_VERSION}, client ${sender.protocolVersion})` };
    }
    const channel = state[role];
    if (sender.socket) {
      if (channel.socket && channel.socket !== sender.socket) {
        try {
          channel.socket.disconnect(true);
        } catch (_) {}
      }
      channel.socket = sender.socket;
      while (channel.queue.length) {
        sender.socket.emit('msg', channel.queue.shift());
      }
    }
    respondChannel(channel, { type: 'hello-ack', role, session: sessionName, protocolVersion: PROTOCOL_VERSION });
    log(`${role.toUpperCase()} registered for session ${sessionName} via socket.io`);
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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (homepage) {
      res.writeHead(302, { Location: homepage });
      res.end();
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });

  const io = new Server(server);

  io.on('connection', (socket) => {
    const { session, role, protocolVersion } = socket.handshake.query || {};
    if (!session || !role) {
      socket.emit('error', { message: 'Missing session/role' });
      socket.disconnect(true);
      return;
    }
    if (protocolVersion && Number(protocolVersion) !== PROTOCOL_VERSION) {
      socket.emit('error', { message: `Protocol mismatch (server ${PROTOCOL_VERSION}, client ${protocolVersion})` });
      socket.disconnect(true);
      return;
    }
    connectionMeta.set(socket.id, { session, role });
    handleHello(session, role, { socket, protocolVersion: Number(protocolVersion) });

    socket.on('msg', (payload) => {
      if (role === 'proxy') {
        routeFromProxy(session, payload);
      } else {
        routeFromLan(session, payload);
      }
    });

    socket.on('disconnect', () => cleanupSocket(socket));
    socket.on('error', (err) => {
      log(`socket error: ${err.message || err}`);
      cleanupSocket(socket);
    });
  });

  server.listen(port, host, () => log(`listening (socket.io) on http://${host}:${port}`));

  return {
    io,
    server,
    stop: () => {
      io.close();
      server.close();
    },
  };
}

module.exports = { startServer };
