#!/usr/bin/env node
const { spawn } = require('child_process');

const scenarios = [{ name: 'socket-io', lanTransport: 'io', proxyTransport: 'io' }];

const targets = [
  { name: 'ifconfig.io', url: 'https://ifconfig.io' },
  { name: 'wikipedia', url: 'https://fr.wikipedia.org/wiki/Wikip%C3%A9dia:Accueil_principal' },
];

const MAX_DURATION_MS = 1500;

const { homepage } = require('../package.json');

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
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  const procs = [];
  try {
    // server
    const srv = startProc('node', ['bin/rwp.js', 'server', '--port', `${serverPort}`, '--host', '127.0.0.1']);
    procs.push(srv);
    await delay(1000);

    // homepage redirect check
    if (homepage) {
      const curlHome = spawn('curl', ['-I', '--max-time', '5', `http://127.0.0.1:${serverPort}`]);
      let homeOut = '';
      let homeErr = '';
      curlHome.stdout.on('data', (d) => (homeOut += d.toString()));
      curlHome.stderr.on('data', (d) => (homeErr += d.toString()));
      const codeHome = await new Promise((resolve) => curlHome.on('close', resolve));
      const okHome = codeHome === 0 && /302/.test(homeOut) && homeOut.toLowerCase().includes(homepage.toLowerCase());
      if (!okHome) {
        return {
          scenario,
          results: [
            { target: 'homepage-redirect', ok: false, curlOut: homeOut, curlErr: homeErr || 'redirect failed' },
          ],
        };
      }
    }

    // lan
    const lanArgs = ['bin/rwp.js', 'lan', session, serverUrl];
    const lan = startProc('node', lanArgs);
    procs.push(lan);
    await delay(1000);

    // proxy
    const proxyArgs = ['bin/rwp.js', 'proxy', session, serverUrl, `${proxyPort}`, '--host', '127.0.0.1'];
    const prx = startProc('node', proxyArgs);
    procs.push(prx);
    await delay(1500);

    const results = [];
    for (const target of targets) {
      const curlCmd = ['curl', '-k', '--max-time', '20', '--proxy', `http://127.0.0.1:${proxyPort}`, target.url];
      const curl = spawn(curlCmd[0], curlCmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let curlOut = '';
      let curlErr = '';
      const start = Date.now();
      curl.stdout.on('data', (d) => (curlOut += d.toString()));
      curl.stderr.on('data', (d) => (curlErr += d.toString()));
      const code = await new Promise((resolve) => curl.on('close', resolve));
      const durationMs = Date.now() - start;
      const ok = code === 0 && durationMs <= MAX_DURATION_MS;
      results.push({
        target: target.name,
        ok,
        durationMs,
        curlOut,
        curlErr: code !== 0 ? curlErr || curlOut : curlErr,
        reason: code !== 0 ? 'curl failed' : durationMs > MAX_DURATION_MS ? `slow: ${durationMs}ms` : '',
      });
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
      const timing = typeof t.durationMs === 'number' ? ` (${t.durationMs} ms)` : '';
      console.log(`  ${t.target}: ${status}${timing}`);
      if (!t.ok) {
        anyFail = true;
        if (t.reason) console.log(`    reason: ${t.reason}`);
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
