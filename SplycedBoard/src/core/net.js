/**
 * Promise helpers for TCP/HTTP servers, so integrations can await start/stop
 * and report "port already in use" as a status instead of crashing the hub.
 *
 * listen() tracks every connection the server accepts, and close() destroys them —
 * server.close() alone waits for clients to hang up, which a Savant host holding a
 * connection open never does.
 */
const CONNECTIONS = Symbol('connections');

function listen(server, port, host = '0.0.0.0') {
  if (!server[CONNECTIONS]) {
    const sockets = new Set();
    server[CONNECTIONS] = sockets;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
  }

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use by another program`));
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Stop accepting connections and drop every open one. */
function close(server, extraSockets = []) {
  for (const s of extraSockets) s.destroy();
  if (!server) return Promise.resolve();
  for (const s of server[CONNECTIONS] || []) s.destroy();
  return new Promise((resolve) => {
    // The callback also fires (with an error) if it was never listening — fine either way.
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

module.exports = { listen, close };
