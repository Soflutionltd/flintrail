// Native messaging host. The browser starts it when the Rocketwright extension asks to pair, and only for
// the extension IDs listed in the host manifest (the browser enforces this). It answers with the relay
// token and port, so the user never has to copy a token by hand.
//
// Protocol (Chrome native messaging): each message is a 32-bit little-endian length, then UTF-8 JSON.
import './legacy-home.js';
import { loadToken } from './auth.js';
import { config } from './config.js';
import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { chosenName, profileOfInstance, profileReadProblems } from './profiles.js';

/** Whether something listens on this port of this computer: a TCP connection, closed at once, nothing sent. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (up: boolean) => { socket.destroy(); resolve(up); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function reply(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function readMessage(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    process.stdin.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length > 1024 * 1024) { reject(new Error('message too large')); return; }
      if (buffer.length < 4 + length) return;
      try { resolve(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))); } catch (e) { reject(e); }
    });
    process.stdin.on('end', () => reject(new Error('no message')));
  });
}

try {
  const message = (await readMessage()) as { type?: string; instance?: string; port?: unknown } | null;
  // Asked before each connection attempt: a WebSocket to a port where nothing listens is logged by the browser as
  // an error in the extension's page, every 30 s while no agent runs. A port number only, on this computer only.
  if (message?.type === 'relay') {
    const port = Number(message.port);
    reply(Number.isInteger(port) && port > 0 && port < 65536 ? { type: 'relay', up: await listening(port) } : { type: 'error', error: 'bad port' });
  }
  else if (message?.type === 'pair') reply({ type: 'paired', token: loadToken(), port: config.relayPort });
  // Started by the browser itself, this process may read the browser's own profile files, which macOS often
  // keeps from other apps (the relay among them): it tells the extension which profile it runs in.
  else if (message?.type === 'profile') {
    const name = chosenName(profileOfInstance(String(message.instance || '')));
    // Not found: say why in ~/.rocketwright/native-host.log (a browser's files closed to this process, most often).
    if (!name) {
      const why = profileReadProblems().join(', ') || 'no profile holds this extension instance';
      try { appendFileSync(join(config.home, 'native-host.log'), `${new Date().toISOString()} profile of ${String(message.instance || '').slice(0, 8)} not found: ${why}\n`); } catch { /* nothing to report to */ }
    }
    reply({ type: 'profile', name });
  }
  else reply({ type: 'error', error: 'unknown request' });
} catch (e) {
  reply({ type: 'error', error: (e as Error).message });
}
process.exit(0);
