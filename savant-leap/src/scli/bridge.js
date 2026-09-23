/**
 * SCLI Bridge — Node.js/Bun port of scli_http.py
 *
 * Port 12000 — clients connect here (HTTP GET or raw TCP)
 *   GET /readstate ...     → runs sclibridge, returns plain text
 *   raw TCP: same commands as HTTP path, no headers
 *
 * Port 12001 — Savant connects here (servicerequestcommand passthrough)
 *   Savant dials in once and holds the connection.
 *   servicerequestcommand is forwarded directly; everything else hits sclibridge.
 */

const net = require('net');
const { execFile } = require('child_process');
const fs = require('fs');

const CLIENT_PORT = 12000;
const SAVANT_PORT = 12001;

const SCLIBRIDGE_CANDIDATES = [
  '/Users/Shared/Savant/Applications/RacePointMedia/sclibridge',
  `${process.env.HOME}/Applications/RacePointMedia/sclibridge`,
  '/usr/local/bin/sclibridge',
];

const VALID_CMD = /^(readstate|writestate|servicerequestcommand|servicerequest|userzones|statenames|settrigger|removetrigger)\b/;

// ── Shared state ──────────────────────────────────────────────────────────────

const state = {
  scliPath: SCLIBRIDGE_CANDIDATES.find(p => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null,
  savantSocket: null,
  savantAddr: null,
  clientServer: null,
  savantServer: null,
};

// ── sclibridge exec ───────────────────────────────────────────────────────────

// Parse "servicerequestcommand Zone-Component-...-Action:arg=val,arg=val" into
// the separate args sclibridge expects: [cmd, dashRequest, name, val, ...]
function parseServiceRequestArgs(command) {
  const rest = command.slice('servicerequestcommand '.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return ['servicerequestcommand', rest.trim()];
  const dashCmd = rest.slice(0, colonIdx).trim();
  const args = ['servicerequestcommand', dashCmd];
  for (const pair of rest.slice(colonIdx + 1).split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name && value !== '') args.push(name, value);
  }
  return args;
}

function runScli(command) {
  return new Promise((resolve) => {
    if (!state.scliPath) {
      resolve(`Error: sclibridge not found (checked: ${SCLIBRIDGE_CANDIDATES.join(', ')})\n`);
      return;
    }
    const parts = command.startsWith('servicerequestcommand ')
      ? parseServiceRequestArgs(command)
      : (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []);
    execFile(state.scliPath, parts, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err && err.code === 'ETIMEDOUT') { resolve('Error: sclibridge timed out\n'); return; }
      resolve(stdout || stderr || '');
    });
  });
}

// ── servicerequestcommand via live Savant socket ──────────────────────────────

function runViaSavant(command) {
  return new Promise((resolve) => {
    const sock = state.savantSocket;
    if (!sock || sock.destroyed) {
      state.savantSocket = null;
      resolve(runScli(command));
      return;
    }
    // Strip the "servicerequestcommand " prefix
    const payload = command.replace(/^servicerequestcommand\s+/, '').trim();
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('\r')) {
        sock.off('data', onData);
        sock.off('error', onErr);
        resolve(buf.replace(/\r/g, '\n'));
      }
    };
    const onErr = (err) => {
      state.savantSocket = null;
      resolve(runScli(command));
    };
    sock.on('data', onData);
    sock.once('error', onErr);
    try {
      sock.write(payload + '\r');
    } catch {
      sock.off('data', onData);
      state.savantSocket = null;
      resolve(runScli(command));
    }
  });
}

// ── Route a command string to the right executor ─────────────────────────────

async function dispatch(command) {
  if (!VALID_CMD.test(command)) return null; // unrecognised
  return runScli(command);
}

// ── Client server (port 12000) ────────────────────────────────────────────────

function handleClient(sock) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.setTimeout(15000);
  sock.once('timeout', () => sock.destroy());

  sock.on('data', async (chunk) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    const firstLine = buf.slice(0, nl).replace(/\r$/, '').trim();
    buf = '';
    sock.removeAllListeners('data');

    let command, isHttp;
    const httpMatch = firstLine.match(/^GET \/([^ ]+) HTTP/);
    if (httpMatch) {
      isHttp = true;
      command = decodeURIComponent(httpMatch[1]).replace(/\0/g, '').trim();
      // Drain remaining headers (fire and forget)
      sock.resume();
    } else {
      isHttp = false;
      command = firstLine.replace(/\0/g, '');
    }

    const result = await dispatch(command);
    if (result === null) {
      // Unrecognised command — close silently
      sock.destroy();
      return;
    }

    if (isHttp) {
      const body = Buffer.from(result, 'utf8');
      const header = [
        'HTTP/1.1 200 OK',
        'Content-Type: text/plain; charset=utf-8',
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      sock.end(header + result);
    } else {
      sock.end(result);
    }
  });

  sock.on('error', () => {});
}

// ── Savant listener (port 12001) ──────────────────────────────────────────────

function handleSavantConn(sock) {
  const addr = `${sock.remoteAddress}:${sock.remotePort}`;
  console.log(`[scli] Savant connected from ${addr}`);
  state.savantSocket = sock;
  state.savantAddr = addr;

  sock.on('close', () => {
    if (state.savantSocket === sock) {
      state.savantSocket = null;
      state.savantAddr = null;
      console.log('[scli] Savant disconnected');
    }
  });
  sock.on('error', () => {});
}

// ── Start ─────────────────────────────────────────────────────────────────────

function startScliBridge() {
  state.clientServer = net.createServer(handleClient);
  state.clientServer.listen(CLIENT_PORT, '0.0.0.0', () => {
    console.log(`[scli] Client server  → port ${CLIENT_PORT}`);
  });

  state.savantServer = net.createServer(handleSavantConn);
  state.savantServer.listen(SAVANT_PORT, '0.0.0.0', () => {
    console.log(`[scli] Savant server  → port ${SAVANT_PORT}`);
    console.log(`[scli] sclibridge     → ${state.scliPath || 'NOT FOUND'}`);
  });

  state.clientServer.on('error', (err) => console.error('[scli] Client server error:', err.message));
  state.savantServer.on('error', (err) => console.error('[scli] Savant server error:', err.message));
}

function getStatus() {
  return {
    scliPath: state.scliPath,
    scliFound: !!state.scliPath,
    savantConnected: !!(state.savantSocket && !state.savantSocket.destroyed),
    savantAddr: state.savantAddr,
    clientPort: CLIENT_PORT,
    savantPort: SAVANT_PORT,
  };
}

module.exports = { startScliBridge, getStatus, dispatch };
