/**
 * A simulated DSC communicator for the ITv2 tests. Like a real TL280 or PowerSeries Pro, it
 * dials the integration server, leads the session handshake (type 1 or type 2 encryption),
 * answers status requests and arm/disarm, and pushes notifications on demand. Remove with
 * src/integrations/dsc/.
 */
const net = require('net');
const crypto = require('crypto');

const DSC = '../../SplycedBoard/src/integrations/dsc/itv2';
const { frame, Deframer } = require(`${DSC}/frame`);
const { encode, decodeAll } = require(`${DSC}/packet`);
const { type1Key, type2Key, aesEcb, pad16, evenBytes, oddBytes } = require(`${DSC}/handshake`);

const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];

/**
 * @param o.port            the server's port
 * @param o.type            1 or 2
 * @param o.integrationId   what the panel is ([422]); o.accessCode what it's programmed with
 * @param o.offerType3      first offer a 5.63-style extended Open Session (type 3)
 */
function connectMockPanel({
  port, type = 1, integrationId = '123456789012', accessCode = type === 1 ? '12345678' : '0123456789ABCDEF0123456789ABCDEF',
  userCode = '1234', zones = 8, partitions = 2, offerType3 = false,
} = {}) {
  const header = Buffer.from(integrationId, 'latin1');
  const panel = {
    step: 'connecting',
    ready: false,
    failed: null,
    received: [], // every packet from the server, decrypted: { cmd, appSeq, payload }
    headers: [], // the header on each of the server's messages
    arming: Object.fromEntries(Array.from({ length: partitions }, (_, i) => [i + 1, 0x00])),
    zoneStatus: Array.from({ length: zones }, () => 0x00),
  };
  let seq = 0;
  let cmdSeq = 0x90;
  let rxKey = null; // what the server encrypts with: our session key
  let txKey = null; // what we encrypt with: the server's
  let panelRandom = null;
  const openBody = (enc) => Buffer.from([0x02, ...u16(0x032b), 0x05, 0x20, ...u16(0x0223), ...u16(0x0200), ...u16(0x0200), 0x00, 0x00, enc]);

  const socket = net.connect({ host: '127.0.0.1', port });
  const send = (p) => socket.write(frame(txKey ? aesEcb('encrypt', txKey, pad16(encode(p))) : encode(p), header));
  const ack = (to) => send({ seq, ack: to.seq });
  const respond = (to, code = 0) => send({ seq: ++seq & 0xff, ack: to.seq, cmd: 0x0502, payload: Buffer.from([to.appSeq, code]) });
  const start = (cmd, payload, withCmdSeq = false) => {
    seq = (seq + 1) & 0xff;
    const p = { seq, ack: panel.lastServerSeq ?? 0, cmd, payload: Buffer.from(payload) };
    if (withCmdSeq) p.appSeq = cmdSeq = (cmdSeq + 1) & 0xff;
    send(p);
  };
  panel.notify = (cmd, payload) => start(cmd, payload);

  socket.on('connect', () => {
    if (offerType3) {
      panel.step = 'offered-type-3';
      send({ seq, ack: 0, cmd: 0x060a, appSeq: cmdSeq, payload: Buffer.concat([openBody(3), Buffer.from([0x03, 0x03, 0x02, 0x01])]) });
    } else {
      panel.step = 'opened';
      send({ seq, ack: 0, cmd: 0x060a, appSeq: cmdSeq, payload: openBody(type) });
    }
  });

  const deframer = new Deframer();
  socket.on('data', (chunk) => {
    for (const { header: h, body } of deframer.push(chunk)) {
      panel.headers.push(h.toString('latin1'));
      const plain = rxKey && body.length % 16 === 0 ? aesEcb('decrypt', rxKey, body) : body;
      for (const p of decodeAll(plain)) {
        panel.lastServerSeq = p.seq;
        panel.received.push(p);
        handle(p);
      }
    }
  });

  function handle(p) {
    switch (panel.step) {
      case 'offered-type-3':
        if (p.cmd === 0x0502 && p.payload[1] === 0x18) {
          panel.step = 'opened';
          start(0x060a, openBody(type), true);
        }
        return;
      case 'opened': // our Open Session answered → ack it
        if (p.cmd === 0x0502) {
          ack(p);
          panel.step = 'wait-server-open';
        }
        return;
      case 'wait-server-open':
        if (p.cmd === 0x060a) {
          respond(p, p.payload.length === 14 ? 0 : 0x02);
          panel.step = 'wait-ack';
        }
        return;
      case 'wait-ack':
        if (p.cmd == null) {
          // Our Request Access: the key the server will encrypt with
          let init;
          if (type === 1) {
            panelRandom = crypto.randomBytes(32);
            init = Buffer.concat([evenBytes(panelRandom), aesEcb('encrypt', type1Key(integrationId), panelRandom)]);
            rxKey = oddBytes(panelRandom);
          } else {
            panelRandom = crypto.randomBytes(16);
            init = panelRandom;
            rxKey = aesEcb('encrypt', type2Key(accessCode), panelRandom);
          }
          start(0x060e, Buffer.concat([Buffer.from([init.length]), init]), true);
          panel.step = 'sent-access';
        }
        return;
      case 'sent-access': // the server's (encrypted) answer → a plain ack
        if (p.cmd === 0x0502) {
          ack(p);
          panel.step = 'wait-server-access';
        }
        return;
      case 'wait-server-access':
        if (p.cmd === 0x060e) {
          const init = p.payload.subarray(1, 1 + p.payload[0]);
          let key = null;
          if (type === 1) {
            const r = aesEcb('decrypt', type1Key(accessCode), init.subarray(16));
            if (evenBytes(r).equals(init.subarray(0, 16))) key = oddBytes(r);
          } else if (init.length === 16) {
            key = aesEcb('encrypt', type2Key(accessCode), init);
          }
          if (!key) {
            panel.failed = 'server key did not check out';
            respond(p, 0x11);
            return;
          }
          txKey = key;
          respond(p, 0);
          panel.step = 'wait-final-ack';
        }
        return;
      case 'wait-final-ack':
        if (p.cmd == null) {
          panel.step = 'ready';
          panel.ready = true;
        }
        return;
      case 'ready':
        ready(p);
        return;
      default:
    }
  }

  function ready(p) {
    if (p.cmd == null || p.cmd === 0x0502) return;
    if (p.cmd === 0x0600) {
      ack(p);
      return;
    }
    if (p.cmd === 0x0800) {
      respond(p, 0);
      const what = p.payload.readUInt16BE(0);
      if (what === 0x0613) start(0x0613, [1, zones, 1, 72, 1, partitions, 1, 32, 1, 0, 1, 2]);
      if (what === 0x0811) {
        // bundled, as real panels may: [length][0811][body] inside a 0623
        const body = [1, 1, 1, zones, 1, ...panel.zoneStatus];
        start(0x0623, [body.length + 2, 0x08, 0x11, ...body]);
      }
      if (what === 0x0812) {
        const n = p.payload[3] === 2 ? 2 : 1;
        const s1 = panel.arming[n] === 0x00 ? 0x02 : 0x01 | (panel.arming[n] === 0x02 ? 0x04 : 0x02);
        start(0x0812, [1, n === 2 ? 0x02 : 0x01, 3, s1, 0x00, 0x00]);
      }
      if (what === 0x0771 && p.payload.readUInt16BE(2) === 0x01d1) {
        start(0x0771, Buffer.concat([Buffer.from([0x01, 0xd1, 1, 1, 1, 2, 1, 8]), Buffer.from('Front DrKitchen ')]));
      }
      return;
    }
    if (p.cmd === 0x0900 || p.cmd === 0x0901) {
      const partition = p.payload[1];
      const codeAt = p.cmd === 0x0900 ? 3 : 2;
      const code = p.payload.subarray(codeAt).toString('hex');
      if (code !== userCode) {
        respond(p, 0x11);
        return;
      }
      respond(p, 0);
      const state = p.cmd === 0x0900 ? p.payload[2] : 0x00;
      panel.arming[partition] = state;
      start(0x0232, [1, partition, state, 0x01, 1, 1]);
      return;
    }
    ack(p);
  }

  return {
    panel,
    close: () => new Promise((resolve) => {
      socket.once('close', resolve);
      socket.destroy();
    }),
  };
}

module.exports = { connectMockPanel };
