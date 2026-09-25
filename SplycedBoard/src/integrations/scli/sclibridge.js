/**
 * SCLI bridge — exposes Savant's `sclibridge` command-line tool over the network.
 *
 * Port 12000 — clients connect here, one command per connection:
 *     HTTP:     GET /readstate%20userDefined.foo HTTP/1.1   → plain-text response
 *     raw TCP:  readstate userDefined.foo\n                 → raw response, then close
 *   Allowed commands: readstate, writestate, servicerequestcommand, servicerequest,
 *   userzones, statenames, settrigger, removetrigger. Anything else is dropped.
 *
 * Port 12001 — the Savant host connects here using the "IP Requests" profile
 *   (profiles/ip_requests.xml) and holds the connection open. It is tracked for
 *   status only; every command is executed through sclibridge.
 */
const net = require('net');
const { execFile } = require('child_process');

const { listen, close } = require('../../core/net');
const { SCLIBRIDGE_CANDIDATES, findSclibridge } = require('../../core/savant');

const CLIENT_PORT = 12000;
const SAVANT_PORT = 12001;
const EXEC_TIMEOUT_MS = 10000;
const CLIENT_IDLE_TIMEOUT_MS = 15000;

const VALID_COMMAND = /^(readstate|writestate|servicerequestcommand|servicerequest|userzones|statenames|settrigger|removetrigger)\b/;

/**
 * "servicerequestcommand Zone-Component-...-Action:arg=val,arg=val" → the separate
 * arguments sclibridge expects: [cmd, dashRequest, name, value, ...]
 */
function parseServiceRequestArgs(command) {
  const rest = command.slice('servicerequestcommand '.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return ['servicerequestcommand', rest.trim()];

  const args = ['servicerequestcommand', rest.slice(0, colonIdx).trim()];
  for (const pair of rest.slice(colonIdx + 1).split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (name && value !== '') args.push(name, value);
  }
  return args;
}

/**
 * Split a command line into arguments the way a shell would: "quoted strings" stay together
 * and lose their quotes, so `readstate "Room 1.Lights"` reads the state Room 1.Lights. Savant's
 * component states usually have a space in them ("Lighting Controller.Lighting_controller.…").
 */
function splitArgs(command) {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
    .map((arg) => arg.replace(/"([^"]*)"|'([^']*)'/g, (_, double, single) => double ?? single));
}

class ScliBridge {
  constructor({ log, clientPort = CLIENT_PORT, savantPort = SAVANT_PORT, scliPath = null }) {
    this.log = log;
    this.clientPort = clientPort;
    this.savantPort = savantPort;
    this.scliPath = scliPath || findSclibridge();
    this.clientServer = null;
    this.savantServer = null;
    this.savantSocket = null; // the most recent Savant connection (for status)
    this.savantAddr = null;
  }

  async start() {
    this.clientServer = net.createServer((sock) => this._onClient(sock));
    this.savantServer = net.createServer((sock) => this._onSavant(sock));

    await listen(this.clientServer, this.clientPort);
    await listen(this.savantServer, this.savantPort);
    this.clientServer.on('error', (err) => this.log.error('Client server error:', err.message));
    this.savantServer.on('error', (err) => this.log.error('Savant server error:', err.message));

    this.log.info(`Client port ${this.clientPort}, Savant port ${this.savantPort}`);
    if (this.scliPath) this.log.info(`sclibridge → ${this.scliPath}`);
    else this.log.warn(`sclibridge not found (checked: ${SCLIBRIDGE_CANDIDATES.join(', ')})`);
  }

  async stop() {
    // close() drops every open connection, including any older Savant sockets.
    await Promise.all([close(this.clientServer), close(this.savantServer)]);
    this.savantSocket = null;
    this.savantAddr = null;
    this.clientServer = null;
    this.savantServer = null;
  }

  get savantConnected() {
    return !!(this.savantSocket && !this.savantSocket.destroyed);
  }

  status() {
    return {
      scliPath: this.scliPath,
      scliFound: !!this.scliPath,
      savantConnected: this.savantConnected,
      savantAddr: this.savantAddr,
      clientPort: this.clientPort,
      savantPort: this.savantPort,
    };
  }

  /** Run an allowed command through sclibridge. Resolves to its output, or null if not allowed. */
  run(command) {
    if (!VALID_COMMAND.test(command)) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (!this.scliPath) {
        resolve(`Error: sclibridge not found (checked: ${SCLIBRIDGE_CANDIDATES.join(', ')})\n`);
        return;
      }
      const args = command.startsWith('servicerequestcommand ') ? parseServiceRequestArgs(command) : splitArgs(command);
      this.log.debug(`exec sclibridge ${args.join(' ')}`);
      execFile(this.scliPath, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
        if (err && err.killed) resolve('Error: sclibridge timed out\n');
        else resolve(stdout || stderr || '');
      });
    });
  }

  // ── Port 12000: one command per connection, HTTP GET or raw line ───────────

  _onClient(sock) {
    sock.on('error', () => {});
    sock.setEncoding('utf8');
    sock.setTimeout(CLIENT_IDLE_TIMEOUT_MS);
    sock.once('timeout', () => sock.destroy());

    let buf = '';
    const onData = async (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      sock.off('data', onData);

      const firstLine = buf.slice(0, nl).replace(/\r$/, '').trim();
      const httpMatch = firstLine.match(/^GET \/([^ ]+) HTTP/);
      let command;
      if (httpMatch) {
        try {
          command = decodeURIComponent(httpMatch[1]).replace(/\0/g, '').trim();
        } catch {
          sock.destroy(); // malformed %-encoding
          return;
        }
        sock.resume(); // drain the remaining request headers
      } else {
        command = firstLine.replace(/\0/g, '');
      }

      const result = await this.run(command);
      if (result === null) {
        this.log.debug(`Rejected command from ${sock.remoteAddress}: ${command.slice(0, 80)}`);
        sock.destroy();
        return;
      }

      if (httpMatch) {
        const body = Buffer.from(result, 'utf8');
        sock.end([
          'HTTP/1.1 200 OK',
          'Content-Type: text/plain; charset=utf-8',
          `Content-Length: ${body.length}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n') + result);
      } else {
        sock.end(result);
      }
    };
    sock.on('data', onData);
  }

  // ── Port 12001: the Savant host's persistent connection ────────────────────

  _onSavant(sock) {
    const addr = `${sock.remoteAddress}:${sock.remotePort}`;
    this.log.info(`Savant connected from ${addr}`);
    this.savantSocket = sock;
    this.savantAddr = addr;
    this.onChange?.();

    sock.on('close', () => {
      if (this.savantSocket !== sock) return;
      this.savantSocket = null;
      this.savantAddr = null;
      this.log.info('Savant disconnected');
      this.onChange?.();
    });
    sock.on('error', () => {});
  }
}

module.exports = { ScliBridge, parseServiceRequestArgs, CLIENT_PORT, SAVANT_PORT };
