/**
 * Handles LEAP certificate-based pairing with Lutron QSX / RA3 processors.
 *
 * Flow (QSX LEAP protocol):
 *  1. Generate RSA key pair + CSR
 *  2. Connect to port 8083 with mutual TLS using the Lutron association cert.
 *     The QSX requires this specific Lutron-issued client certificate during the
 *     TLS handshake — without it the connection is dropped immediately.
 *  3. Processor sends an unsolicited status message on connect.
 *  4. Client sends an Execute /pair request with the CSR.
 *  5. User presses the physical pairing button on the QSX within 60s.
 *  6. Processor sends a SigningResult with the signed client cert + CA cert.
 */
const tls = require('tls');
const crypto = require('crypto');
const forge = require('node-forge');

const PAIRING_PORT = 8083;
const PAIRING_TIMEOUT_MS = 60000;

// Lutron association certificates required for mutual TLS on port 8083.
// Source: https://github.com/thenewwazoo/lutron-leap-js/blob/main/src/Association.ts
const ASSOC_CA = `-----BEGIN CERTIFICATE-----
MIIEsjCCA5qgAwIBAgIBATANBgkqhkiG9w0BAQ0FADCBlzELMAkGA1UEBhMCVVMx
FTATBgNVBAgTDFBlbm5zeWx2YW5pYTElMCMGA1UEChMcTHV0cm9uIEVsZWN0cm9u
aWNzIENvLiwgSW5jLjEUMBIGA1UEBxMLQ29vcGVyc2J1cmcxNDAyBgNVBAMTK0Nh
c2V0YSBMb2NhbCBBY2Nlc3MgUHJvdG9jb2wgQ2VydCBBdXRob3JpdHkwHhcNMTUx
MDMxMDAwMDAwWhcNMzUxMDMxMDAwMDAwWjCBlzELMAkGA1UEBhMCVVMxFTATBgNV
BAgTDFBlbm5zeWx2YW5pYTElMCMGA1UEChMcTHV0cm9uIEVsZWN0cm9uaWNzIENv
LiwgSW5jLjEUMBIGA1UEBxMLQ29vcGVyc2J1cmcxNDAyBgNVBAMTK0Nhc2V0YSBM
b2NhbCBBY2Nlc3MgUHJvdG9jb2wgQ2VydCBBdXRob3JpdHkwggEiMA0GCSqGSIb3
DQEBAQUAA4IBDwAwggEKAoIBAQDamUREO0dENJxvxdbsDATdDFq+nXdbe62XJ4hI
t15nrUolwv7S28M/6uPPFtRSJW9mwvk/OKDlz0G2D3jw6SdzV3I7tNzvDptvbAL2
aDy9YNp9wTub/pLF6ONDa56gfAxsPQnMBwgoZlKqNQQsjykiyBv8FX42h3Nsa+Bl
q3hjnZEdOAkdn0rvCWD605c0+VWWOWm2vv7bwyOsfgsvCPxooAyBhTDeA0JPjVE/
wHPfiDF3WqA8JzWv4Ibvkg1g33oD6lG8LulWKDS9TPBYF+cvJ40aFPMreMoAQcrX
uD15vaS7iWXKI+anVrBpqE6pRkwLhR+moFjv5GZ+9oP8eawzAgMBAAGjggEFMIIB
ATAMBgNVHRMEBTADAQH/MB0GA1UdDgQWBBSB7qznOajKywOtZypVvV7ECAsgZjCB
xAYDVR0jBIG8MIG5gBSB7qznOajKywOtZypVvV7ECAsgZqGBnaSBmjCBlzELMAkG
A1UEBhMCVVMxFTATBgNVBAgTDFBlbm5zeWx2YW5pYTElMCMGA1UEChMcTHV0cm9u
IEVsZWN0cm9uaWNzIENvLiwgSW5jLjEUMBIGA1UEBxMLQ29vcGVyc2J1cmcxNDAy
BgNVBAMTK0Nhc2V0YSBMb2NhbCBBY2Nlc3MgUHJvdG9jb2wgQ2VydCBBdXRob3Jp
dHmCAQEwCwYDVR0PBAQDAgG+MA0GCSqGSIb3DQEBDQUAA4IBAQB9UDVi2DQI7vHp
F2Lape8SCtcdGEY/7BV4a3F+Xp9WxpE4bVtwoHlb+HG4tYQk9LO7jReE3VBmzvmU
aj+Y3xa25PSb+/q6U6MuY5OscyWo6ZGwtlsrWcP5xsey950WLwW6i8mfIkqFf6uT
gPbUjLsOstB4p7PQVpFgS2rP8h50Psue+XtUKRpR+JSBrHXKX9VuU/aM4PYexSvF
WSHa2HEbjvp6ccPm53/9/EtOtzcUMNspKt3YzABAoQ5/69nebRtC5lWjFI0Ga6kv
zKyu/aZJXWqskHkMz+Mbnky8tP37NmVkMnmRLCfdCG0gHiq/C2tjWDfPQID6HY0s
zq38av5E
-----END CERTIFICATE-----`;

const ASSOC_CERT = `-----BEGIN CERTIFICATE-----
MIIECjCCAvKgAwIBAgIBAzANBgkqhkiG9w0BAQ0FADCBlzELMAkGA1UEBhMCVVMx
FTATBgNVBAgTDFBlbm5zeWx2YW5pYTElMCMGA1UEChMcTHV0cm9uIEVsZWN0cm9u
aWNzIENvLiwgSW5jLjEUMBIGA1UEBxMLQ29vcGVyc2J1cmcxNDAyBgNVBAMTK0Nh
c2V0YSBMb2NhbCBBY2Nlc3MgUHJvdG9jb2wgQ2VydCBBdXRob3JpdHkwHhcNMTUx
MDMxMDAwMDAwWhcNMzUxMDMxMDAwMDAwWjB+MQswCQYDVQQGEwJVUzEVMBMGA1UE
CBMMUGVubnN5bHZhbmlhMSUwIwYDVQQKExxMdXRyb24gRWxlY3Ryb25pY3MgQ28u
LCBJbmMuMRQwEgYDVQQHEwtDb29wZXJzYnVyZzEbMBkGA1UEAxMSQ2FzZXRhIEFw
cGxpY2F0aW9uMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyAOELqTw
WNkF8ofSYJ9QkOHAYMmkVSRjVvZU2AqFfaZYCfWLoors7EBeQrsuGyojqxCbtRUd
l2NQrkPrGVw9cp4qsK54H8ntVadNsYi7KAfDW8bHQNf3hzfcpe8ycXcdVPZram6W
pM9P7oS36jV2DLU59A/OGkcO5AkC0v5ESqzab3qaV3ZvELP6qSt5K4MaJmm8lZT2
6deHU7Nw3kR8fv41qAFe/B0NV7IT+hN+cn6uJBxG5IdAimr4Kl+vTW9tb+/Hh+f+
pQ8EzzyWyEELRp2C72MsmONarnomei0W7dVYbsgxUNFXLZiXBdtNjPCMv1u6Znhm
QMIu9Fhjtz18LwIDAQABo3kwdzAJBgNVHRMEAjAAMB0GA1UdDgQWBBTiN03yqw/B
WK/jgf6FNCZ8D+SgwDAfBgNVHSMEGDAWgBSB7qznOajKywOtZypVvV7ECAsgZjAL
BgNVHQ8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUFBwMCMA0GCSqG
SIb3DQEBDQUAA4IBAQABdgPkGvuSBCwWVGO/uzFEIyRius/BF/EOZ7hMuZluaF05
/FT5PYPWg+UFPORUevB6EHyfezv+XLLpcHkj37sxhXdDKB4rrQPNDY8wzS9DAqF4
WQtGMdY8W9z0gDzajrXRbXkYLDEXnouUWA8+AblROl1Jr2GlUsVujI6NE6Yz5JcJ
zDLVYx7pNZkhYcmEnKZ30+ICq6+0GNKMW+irogm1WkyFp4NHiMCQ6D2UMAIMfeI4
xsamcaGquzVMxmb+Py8gmgtjbpnO8ZAHV6x3BG04zcaHRDOqyA4g+Xhhbxp291c8
B31ZKg0R+JaGyy6ZpE5UPLVyUtLlN93V2V8n66kR
-----END CERTIFICATE-----`;

const ASSOC_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEAyAOELqTwWNkF8ofSYJ9QkOHAYMmkVSRjVvZU2AqFfaZYCfWL
oors7EBeQrsuGyojqxCbtRUdl2NQrkPrGVw9cp4qsK54H8ntVadNsYi7KAfDW8bH
QNf3hzfcpe8ycXcdVPZram6WpM9P7oS36jV2DLU59A/OGkcO5AkC0v5ESqzab3qa
V3ZvELP6qSt5K4MaJmm8lZT26deHU7Nw3kR8fv41qAFe/B0NV7IT+hN+cn6uJBxG
5IdAimr4Kl+vTW9tb+/Hh+f+pQ8EzzyWyEELRp2C72MsmONarnomei0W7dVYbsgx
UNFXLZiXBdtNjPCMv1u6ZnhmQMIu9Fhjtz18LwIDAQABAoIBAQCXDtDNyZQcBgwP
17RzdN8MDPOWJbQO+aRtES2S3J9k/jSPkPscj3/QDe0iyOtRaMn3cFuor4HhzAgr
FPCB/sAJyJrFRX9DwuWUQv7SjkmLOhG5Rq9FsdYoMXBbggO+3g8xE8qcX1k2r7vW
kDW2lRnLDzPtt+IYxoHgh02yvIYnPn1VLuryM0+7eUrTVmdHQ1IGS5RRAGvtoFjf
4QhkkwLzZzCBly/iUDtNiincwRx7wUG60c4ZYu/uBbdJKT+8NcDLnh6lZyJIpGns
jjZvvYA9kgCB2QgQ0sdvm0rA31cbc72Y2lNdtE30DJHCQz/K3X7T0PlfR191NMiX
E7h2I/oBAoGBAPor1TqsQK0tT5CftdN6j49gtHcPXVoJQNhPyQldKXADIy8PVGnn
upG3y6wrKEb0w8BwaZgLAtqOO/TGPuLLFQ7Ln00nEVsCfWYs13IzXjCCR0daOvcF
3FCb0IT/HHym3ebtk9gvFY8Y9AcV/GMH5WkAufWxAbB7J82M//afSghPAoGBAMys
g9D0FYO/BDimcBbUBpGh7ec+XLPaB2cPM6PtXzMDmkqy858sTNBLLEDLl+B9yINi
FYcxpR7viNDAWtilVGKwkU3hM514k+xrEr7jJraLzd0j5mjp55dnmH0MH0APjEV0
qum+mIJmWXlkfKKIiIDgr6+FwIiF5ttSbX1NwnYhAoGAMRvjqrXfqF8prEk9xzra
7ZldM7YHbEI+wXfADh+En+FtybInrvZ3UF2VFMIQEQXBW4h1ogwfTkn3iRBVje2x
v4rHRbzykjwF48XPsTJWPg2E8oPK6Wz0F7rOjx0JOYsEKm3exORRRhru5Gkzdzk4
lok29/z8SOmUIayZHo+cV88CgYEAgPsmhoOLG19A9cJNWNV83kHBfryaBu0bRSMb
U+6+05MtpG1pgaGVNp5o4NxsdZhOyB0DnBL5D6m7+nF9zpFBwH+s0ftdX5sg/Rfs
1Eapmtg3f2ikRvFAdPVf7024U9J4fzyqiGsICQUe1ZUxxetsumrdzCrpzh80AHrN
bO2X4oECgYEAxoVXNMdFH5vaTo3X/mOaCi0/j7tOgThvGh0bWcRVIm/6ho1HXk+o
+kY8ld0vCa7VvqT+iwPt+7x96qesVPyWQN3+uLz9oL3hMOaXCpo+5w8U2Qxjinod
uHnNjMTXCVxNy4tkARwLRwI+1aV5PMzFSi+HyuWmBaWOe19uz3SFbYs=
-----END RSA PRIVATE KEY-----`;

async function generateKeyAndCSR(displayName) {
  const { privateKey: privateKeyPem, publicKey: publicKeyPem } = await new Promise((resolve, reject) => {
    crypto.generateKeyPair('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }, (err, pub, priv) => {
      if (err) reject(err);
      else resolve({ privateKey: priv, publicKey: pub });
    });
  });

  const forgePrivKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const forgePubKey  = forge.pki.publicKeyFromPem(publicKeyPem);

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forgePubKey;
  csr.setSubject([{ name: 'commonName', value: displayName }]);
  csr.sign(forgePrivKey, forge.md.sha256.create());

  return {
    privateKey: privateKeyPem,
    csr: forge.pki.certificationRequestToPem(csr),
  };
}

async function pairWithProcessor(host, displayName = 'Savant Bridge', { log }) {
  log.info('Generating key pair...');
  const { privateKey, csr } = await generateKeyAndCSR(displayName);

  log.info(`Connecting to ${host}:${PAIRING_PORT}...`);

  return new Promise((resolve, reject) => {
    let settled = false;
    function done(err, result) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(result);
    }

    const socket = tls.connect({
      host,
      port: PAIRING_PORT,
      // Mutual TLS: present the Lutron association certificate.
      // The QSX requires this to keep the connection open.
      ca:   ASSOC_CA,
      cert: ASSOC_CERT,
      key:  ASSOC_KEY,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    });

    socket.setTimeout(PAIRING_TIMEOUT_MS);

    let csrSent = false;

    function sendCSR() {
      if (csrSent) return;
      csrSent = true;
      const request = {
        Header: {
          RequestType: 'Execute',
          Url: '/pair',
          ClientTag: 'get-cert',
        },
        Body: {
          CommandType: 'CSR',
          Parameters: {
            CSR: csr,
            DisplayName: displayName,
            DeviceUID: '000000000000',
            Role: 'Admin',
          },
        },
      };
      const payload = JSON.stringify(request) + '\n';
      log.debug(`→ sending CSR (${payload.length} bytes)`);
      socket.write(payload);
    }

    socket.on('secureConnect', () => {
      log.info('TLS connected — press the pairing button on the QSX now...');
    });

    let buffer = '';

    function processMessage(line) {
      if (!line.trim()) return;
      log.debug(`← ${line.slice(0, 500)}`);

      let msg;
      try { msg = JSON.parse(line); } catch { return; }

      const statusCode  = msg.Header?.StatusCode || '';
      const contentType = msg.Header?.ContentType || '';
      const clientTag   = msg.Header?.ClientTag;

      // Unsolicited server status — sent when button is pressed (PhysicalAccess granted)
      if (!clientTag && contentType.startsWith('status')) {
        const permissions = msg.Body?.Status?.Permissions || [];
        log.info(`Server status received — permissions: ${JSON.stringify(permissions)}`);
        if (permissions.includes('PhysicalAccess')) {
          log.info('PhysicalAccess granted — sending CSR...');
          sendCSR();
        } else {
          log.info('Waiting for button press on QSX...');
        }
        return;
      }

      // Successful pairing response
      if (clientTag === 'get-cert' && contentType.startsWith('signing-result')) {
        const cert = msg.Body?.SigningResult?.Certificate;
        const ca   = msg.Body?.SigningResult?.RootCertificate;

        socket.destroy();
        if (!cert) {
          done(new Error(`Pairing response missing certificate. Body: ${JSON.stringify(msg.Body)}`));
        } else {
          log.info('Pairing successful');
          done(null, { ca: ca || '', cert, key: privateKey });
        }
        return;
      }

      // Error response
      if (statusCode.startsWith('4') || statusCode.startsWith('5')) {
        socket.destroy();
        const hint = statusCode.startsWith('401')
          ? ' Press the pairing button on the QSX within 60s of clicking Pair.'
          : '';
        done(new Error(`Processor rejected pairing (${statusCode}).${hint} Body: ${JSON.stringify(msg.Body)}`));
        return;
      }

      log.info(`Received message (tag=${clientTag}, type=${contentType})`);
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) processMessage(line);

      // Handle response with no trailing newline
      if (buffer.trim()) {
        try { JSON.parse(buffer); processMessage(buffer); buffer = ''; } catch { /* incomplete */ }
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      done(new Error(
        'Pairing timed out (60s). Make sure to press the pairing button on the QSX within 60s of clicking Pair.'
      ));
    });

    socket.on('error', (err) => {
      done(new Error(`Pairing connection error: ${err.message}`));
    });

    socket.on('close', () => {
      done(new Error('Processor closed the connection before pairing completed.'));
    });
  });
}

module.exports = { pairWithProcessor };
