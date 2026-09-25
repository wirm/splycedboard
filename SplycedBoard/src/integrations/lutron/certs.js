/**
 * Stores the client certificates issued by the processor during pairing:
 *   data/lutron/certs/<processorId>-ca.crt | -client.crt | -client.key
 */
const fs = require('fs');
const path = require('path');

class CertStore {
  constructor(dir) {
    this.dir = dir;
  }

  paths(processorId) {
    return {
      ca: path.join(this.dir, `${processorId}-ca.crt`),
      cert: path.join(this.dir, `${processorId}-client.crt`),
      key: path.join(this.dir, `${processorId}-client.key`),
    };
  }

  has(processorId) {
    return Object.values(this.paths(processorId)).every((p) => fs.existsSync(p));
  }

  load(processorId) {
    const p = this.paths(processorId);
    try {
      return { ca: fs.readFileSync(p.ca), cert: fs.readFileSync(p.cert), key: fs.readFileSync(p.key) };
    } catch {
      return null;
    }
  }

  save(processorId, { ca, cert, key }) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const p = this.paths(processorId);
    fs.writeFileSync(p.ca, ca);
    fs.writeFileSync(p.cert, cert);
    fs.writeFileSync(p.key, key, { mode: 0o600 });
    return p;
  }
}

module.exports = { CertStore };
