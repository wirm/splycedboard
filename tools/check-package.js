#!/usr/bin/env node
/**
 * Test-installs the package the way a Pro Host gets it: unpack dist/SplycedBoard.tar.gz and run
 * its ./install (headless, into a throwaway home folder, launchd skipped). Then it runs the
 * service exactly as the launchd agent would (same program, folder and environment) and
 * switches every integration on.
 *
 * `npm test` runs from the repository, so it can't notice a file or dependency the package is
 * missing. This can. It also checks that the .zip (for browsers) holds the same files as the
 * .tar.gz, executable bits included.
 *
 *   npm run package && npm run check-package      (macOS only, like the installer)
 */
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'splycedboard-check-'));
const home = path.join(work, 'home');
const appDir = path.join(home, 'Library', 'Application Support', 'SplycedBoard');
const serviceOutput = path.join(work, 'service-output.log');
let service = null;

const step = (msg) => console.log(`\n── ${msg} ──`);
const ok = (msg) => console.log(`  ✓  ${msg}`);
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// Every file under dir → whether it's executable, keyed by path relative to dir.
function tree(dir) {
  const files = new Map();
  (function walk(rel) {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const p = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(p);
      else files.set(p, (fs.statSync(path.join(dir, p)).mode & 0o111) !== 0);
    }
  })('');
  return files;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, ms, what) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      if (err.fatal) throw err;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  check(process.platform === 'darwin', 'The installer only runs on macOS');
  const tgz = path.join(DIST, 'SplycedBoard.tar.gz');
  const zip = path.join(DIST, 'SplycedBoard.zip');
  for (const f of [tgz, zip]) check(fs.existsSync(f), `dist/${path.basename(f)} is missing: run npm run package first`);

  step('Unpacking');
  const fromTar = path.join(work, 'tar');
  const fromZip = path.join(work, 'zip');
  fs.mkdirSync(fromTar);
  fs.mkdirSync(fromZip);
  run('tar', ['-xzf', tgz, '-C', fromTar]);
  run('ditto', ['-x', '-k', zip, fromZip]); // what Archive Utility, and so Safari, uses
  for (const dir of [fromTar, fromZip]) {
    check(fs.readdirSync(dir).join() === 'SplycedBoard', 'The package should hold exactly one folder, SplycedBoard');
  }
  const pkgDir = path.join(fromTar, 'SplycedBoard');
  const files = tree(pkgDir);
  const zipFiles = tree(path.join(fromZip, 'SplycedBoard'));
  check(files.size === zipFiles.size && [...files].every(([f, exec]) => zipFiles.get(f) === exec),
    'SplycedBoard.zip and SplycedBoard.tar.gz hold different files or executable bits');
  check(files.get('install'), 'install is not executable in the package');
  ok(`${files.size} files, the same in both, executable bits included`);

  step('Installing (headless, into a throwaway home folder, launchd skipped)');
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  const port = await freePort();
  run(path.join(pkgDir, 'install'), ['--headless', '--yes'], {
    cwd: work,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: work, SPLYCEDBOARD_WEB_PORT: String(port), SB_SKIP_LAUNCHD: '1' },
  });

  step('Starting it the way launchd does');
  const plistFile = path.join(home, 'Library', 'LaunchAgents', 'com.splycedboard.hub.plist');
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plistFile], { encoding: 'utf8' }));
  const [program, ...args] = plist.ProgramArguments;
  const out = fs.openSync(serviceOutput, 'w');
  service = spawn(program, args, { cwd: plist.WorkingDirectory, env: plist.EnvironmentVariables, stdio: ['ignore', out, out] });
  const exited = new Promise((resolve) => service.on('exit', (code, signal) => resolve({ code, signal })));

  const base = `http://127.0.0.1:${port}`;
  const request = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body && JSON.stringify(body),
    });
    check(res.ok, `${method} ${url} answered HTTP ${res.status}`);
    return res;
  };

  const hub = await waitFor(async () => {
    if (service.exitCode !== null || service.signalCode !== null) {
      throw Object.assign(new Error('The service exited while starting'), { fatal: true });
    }
    return (await request('GET', '/api/hub')).json();
  }, 30000, `the service to answer on port ${port}`);
  const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
  check(hub.app.version === version, `It reports v${hub.app.version}, but the package is v${version}`);
  check(hub.app.managed === true, "It didn't get SPLYCEDBOARD_MANAGED from the launchd agent");
  check(fs.realpathSync(hub.app.dirs.app) === fs.realpathSync(appDir), `It runs from ${hub.app.dirs.app}, not the installed copy`);
  ok(`v${version} on ${hub.app.runtime}, running from the installed copy`);

  step('Switching every integration on');
  check(hub.integrations.length > 0, 'No integrations were loaded');
  for (const { id, name, profile, ui } of hub.integrations) {
    // Only whether it started: off a Savant host some report missing hardware (the SCLI
    // Bridge has no sclibridge here), and that's not the package's fault.
    const state = await (await request('PUT', `/api/hub/integrations/${id}`, { enabled: true })).json();
    check(state.running, `${name} didn't start: ${state.status.text}`);
    if (profile) await request('GET', `/api/hub/integrations/${id}/profile`);
    if (ui) {
      await request('GET', `/ui/${id}/panel.html`);
      if (ui.js) await request('GET', `/ui/${id}/panel.js`);
      if (ui.css) await request('GET', `/ui/${id}/panel.css`);
    }
    ok(`${name} is running (${state.status.text})`);
  }
  check((await (await request('GET', '/')).text()).includes('</html>'), 'The dashboard page is missing');
  ok('The dashboard, its panels and the Savant profiles are all served');

  step('Stopping it the way launchd does (SIGTERM)');
  service.kill('SIGTERM');
  const timeout = new Promise((resolve) => setTimeout(resolve, 10000, { timedOut: true }).unref());
  const result = await Promise.race([exited, timeout]);
  check(!result.timedOut, "It didn't stop within 10 s of SIGTERM");
  check(result.code === 0, `It exited with ${result.signal || `code ${result.code}`} instead of stopping cleanly`);
  ok('Stopped cleanly');
}

function tail(file, lines = 30) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).map((l) => `     ${l}`).join('\n');
  } catch {
    return null;
  }
}

main().then(
  () => console.log('\n✓ The package installs and runs.\n'),
  (err) => {
    console.error(`\n✗ ${err.message}`);
    for (const file of [serviceOutput, path.join(appDir, 'logs', 'splycedboard.log')]) {
      const text = tail(file);
      if (text) console.error(`\n  ${path.basename(file)}:\n${text}`);
    }
    process.exitCode = 1;
  },
).finally(() => {
  if (service && service.exitCode === null && service.signalCode === null) service.kill('SIGKILL');
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
});
