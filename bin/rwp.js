#!/usr/bin/env node
const { program } = require('commander');
const { startServer } = require('../src/server');
const { startLan } = require('../src/lan');
const { startProxy } = require('../src/proxy');

program.name('rwp').description('Remote WebSocket proxy (server, LAN agent, local proxy)');

program
  .command('server')
  .description('Start the WebSocket relay server')
  .option('-p, --port <number>', 'Listening port', (value) => Number(value), 8080)
  .option('-H, --host <host>', 'Listening host', '0.0.0.0')
  .action((options) => {
    startServer({ port: options.port, host: options.host });
  });

function looksLikeUrl(value) {
  return typeof value === 'string' && /(ws|wss|http|https):\/\//i.test(value);
}

function isNumeric(value) {
  return value !== undefined && value !== null && !Number.isNaN(Number(value));
}

function resolveServerAndSession(first, second) {
  let serverUrl;
  let session;
  if (looksLikeUrl(first)) {
    serverUrl = first;
    session = looksLikeUrl(second) ? undefined : second;
  } else if (looksLikeUrl(second)) {
    session = first;
    serverUrl = second;
  }
  return { serverUrl, session };
}

program
  .command('lan <arg1> [arg2]')
  .description('Register the LAN agent for a session (session can be path segment in server URL)')
  .option('-x, --proxy <url>', 'HTTP/HTTPS proxy URL to reach the server')
  .option('--insecure', 'Disable TLS verification to the server/proxy (use only for testing)')
  .option('-t, --transport <mode>', 'Transport mode (socket.io only now)', 'io')
  .option('--tunnel-proxy <url>', 'HTTP/HTTPS proxy to reach target hosts for CONNECT tunnels (TCP). Use "true" to reuse --proxy.')
  .option('--debug', 'Verbose debug logs for HTTP transport')
  .action((arg1, arg2, options) => {
    const { serverUrl, session } = resolveServerAndSession(arg1, arg2);
    if (!serverUrl) {
      console.error('Usage: rwp lan <session> <serverUrl> OR rwp lan <serverUrl-with-session>');
      process.exit(1);
    }
    startLan({
      session,
      serverUrl,
      proxyUrl: options.proxy,
      tunnelProxy: options.tunnelProxy === 'true' ? true : options.tunnelProxy,
      insecure: options.insecure,
      transport: options.transport,
      debug: options.debug,
    });
  });

program
  .command('proxy <arg1> [arg2] [port]')
  .description('Run the local HTTP proxy and connect to the server for the session (session can be path segment in server URL)')
  .option('-H, --host <host>', 'Local proxy host', '127.0.0.1')
  .option('-x, --proxy <url>', 'HTTP/HTTPS proxy URL to reach the server')
  .option('--insecure', 'Disable TLS verification to the server/proxy (use only for testing)')
  .option('-t, --transport <mode>', 'Transport mode (socket.io only now)', 'io')
  .option('--debug', 'Verbose debug logs for HTTP transport')
  .action((arg1, arg2, port, options) => {
    let portArg = port;
    // Two-argument form: `rwp proxy <serverUrl> <port>`
    if (!portArg && isNumeric(arg2) && looksLikeUrl(arg1)) {
      portArg = arg2;
      arg2 = undefined;
    }
    const { serverUrl, session } = resolveServerAndSession(arg1, arg2);
    if (!serverUrl) {
      console.error('Usage: rwp proxy <session> <serverUrl> [port] OR rwp proxy <serverUrl-with-session> [port]');
      process.exit(1);
    }
    const listenPort = portArg && !Number.isNaN(Number(portArg)) ? Number(portArg) : 3128;
    startProxy({
      session,
      serverUrl,
      port: listenPort,
      host: options.host,
      proxyUrl: options.proxy,
      insecure: options.insecure,
      transport: options.transport,
      debug: options.debug,
    });
  });

program.parse();
