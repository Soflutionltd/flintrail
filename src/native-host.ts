// Native messaging host. The browser starts it when the Flintrail extension asks to pair, and only for
// the extension IDs listed in the host manifest (the browser enforces this). It answers with the relay
// token and port, so the user never has to copy a token by hand.
//
// Protocol (Chrome native messaging): each message is a 32-bit little-endian length, then UTF-8 JSON.
import { loadToken } from './auth.js';
import { config } from './config.js';
import { profileOfInstance } from './profiles.js';

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
  const message = (await readMessage()) as { type?: string; instance?: string } | null;
  if (message?.type === 'pair') reply({ type: 'paired', token: loadToken(), port: config.relayPort });
  // Started by the browser itself, this process may read the browser's own profile files, which macOS often
  // keeps from other apps (the relay among them): it tells the extension which profile it runs in.
  else if (message?.type === 'profile') reply({ type: 'profile', name: profileOfInstance(String(message.instance || ''))?.name || '' });
  else reply({ type: 'error', error: 'unknown request' });
} catch (e) {
  reply({ type: 'error', error: (e as Error).message });
}
process.exit(0);
