import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

/** Shared secret for the HTTP transport and the extension relay. Created once in ~/.flintrail/token. */
export function loadToken(explicit?: string): string {
  const given = explicit || process.env.FLINTRAIL_TOKEN || '';
  if (given) return given;
  const f = join(config.home, 'token');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  mkdirSync(config.home, { recursive: true });
  const t = randomBytes(24).toString('base64url');
  writeFileSync(f, t, { mode: 0o600 });
  return t;
}
