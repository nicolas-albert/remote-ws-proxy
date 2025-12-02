#!/usr/bin/env node
const { spawn } = require('child_process');

const scenarios = [
  { name: 'lan-ws_proxy-ws', lanTransport: 'ws', proxyTransport: 'ws' },
  { name: 'lan-http_proxy-ws', lanTransport: 'http', proxyTransport: 'ws' },
  { name: 'lan-ws_proxy-http', lanTransport: 'ws', proxyTransport: 'http' },
  { name: 'lan-http_proxy-http', lanTransport: 'http', proxyTransport: 'http' },
];

const targets = [
  { name: 'ifconfig.io', url: 'https://ifconfig.io' },
  { name: 'wikipedia', url: 'https://fr.wikipedia.org/wiki/Wikip%C3%A9dia:Accueil_principal' },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startProc(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d.toString();
    if (opts.onStdout) opts.onStdout(d.toString());
  });
  child.stderr.on('data', (d) => {
    output += d.toString();
    if (opts.onStderr) opts.onStderr(d.toString());
  });
  const kill = () => {
    try {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
    } catch (_) {
      /* ignore */
    }
  };
  return { child, outputRef: () => output, kill };
}

async function runScenario(idx, scenario) {
  const basePort = 19000 + idx * 20;
  const serverPort = basePort;
  const proxyPort = basePort + 1;
  const session = `test-${idx + 1}`;
  const serverUrl = `ws://127.0.0.1:${serverPort}`;

  const procs = [];
  try {
    // server
    const srv = startProc('node', ['bin/rwp.js', 'server', '--port', `${serverPort}`, '--host', '127.0.0.1']);
    procs.push(srv);
    await delay(1000);

    // lan
    const lanArgs = [
      'bin/rwp.js',
      'lan',
      '--transport',
      scenario.lanTransport,
      session,
      serverUrl,
      '--debug',
    ];
    if (scenario.lanTransport === 'http') {
      lanArgs.push('--insecure');
    }
    const lan = startProc('node', lanArgs);
    procs.push(lan);
    await delay(1000);

    // proxy
    const proxyArgs = [
      'bin/rwp.js',
      'proxy',
      '--transport',
      scenario.proxyTransport,
      session,
      serverUrl,
      `${proxyPort}`,
      '--host',
      '127.0.0.1',
      '--debug',
    ];
    if (scenario.proxyTransport === 'http') {
      proxyArgs.push('--insecure');
    }
    const prx = startProc('node', proxyArgs);
    procs.push(prx);
    await delay(1500);

    const results = [];
    for (const target of targets) {
      const curlCmd = ['curl', '-k', '--max-time', '20', '--proxy', `http://127.0.0.1:${proxyPort}`, target.url];
      const curl = spawn(curlCmd[0], curlCmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let curlOut = '';
      let curlErr = '';
      curl.stdout.on('data', (d) => (curlOut += d.toString()));
      curl.stderr.on('data', (d) => (curlErr += d.toString()));
      const code = await new Promise((resolve) => curl.on('close', resolve));
      results.push({ target: target.name, ok: code === 0, curlOut, curlErr });
    }

    return { scenario, results };
  } finally {
    procs.reverse().forEach((p) => p.kill && p.kill());
    await delay(500);
  }
}

async function main() {
  const results = [];
  for (let i = 0; i < scenarios.length; i += 1) {
    const res = await runScenario(i, scenarios[i]);
    results.push(res);
  }
  let anyFail = false;
  results.forEach((r) => {
    console.log(`\n[${r.scenario.name}]`);
    r.results.forEach((t) => {
      const status = t.ok ? 'OK' : 'FAIL';
      console.log(`  ${t.target}: ${status}`);
      if (!t.ok) {
        anyFail = true;
        console.log(t.curlErr || t.curlOut);
      }
    });
  });
  if (anyFail) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
