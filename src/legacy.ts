// What an install from before the rename left (Flintrail, 1.x), taken up before anything reads it.
//
// - A FLINTRAIL_* variable stands for its ROCKETWRIGHT_* one when that is not set, so an MCP client's
//   configuration or a shell profile written for Flintrail goes on working.
// - ~/.flintrail (the pairing token, the browsers' names, the flows) becomes ~/.rocketwright, with a link
//   left where it was: a relay or a native host of the old install still running finds its files, and so
//   does the host script the browsers were given. Nothing is moved when ROCKETWRIGHT_HOME names a place.
//
// What the installed extension and the server say to each other keeps its old spelling on purpose (the
// native host com.soflution.flintrail, the flintrail* relay parameters): an extension from the store and a
// server from npm update at different times, and each must still understand the other.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OLD_PREFIX = 'FLINTRAIL_';
const NEW_PREFIX = 'ROCKETWRIGHT_';

/** Gives each FLINTRAIL_* variable's value to its ROCKETWRIGHT_* one, where that is not set. Returns the names given a value. */
export function adoptEnvironment(env: NodeJS.ProcessEnv): string[] {
  const adopted: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(OLD_PREFIX) || value === undefined) continue;
    const next = NEW_PREFIX + name.slice(OLD_PREFIX.length);
    if (env[next] === undefined) {
      env[next] = value;
      adopted.push(next);
    }
  }
  return adopted.sort();
}

const isLink = (path: string) => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};
const isFolder = (path: string) => {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
};

/**
 * Moves ~/.flintrail to ~/.rocketwright and leaves a link. Where ~/.rocketwright is there already without a
 * token (another tool's leftovers), what ~/.flintrail holds is moved into it, entry by entry, nothing replaced.
 * Returns what could not be done, said for a person.
 */
export function moveHome(home: string, env: NodeJS.ProcessEnv): string[] {
  if ((env.ROCKETWRIGHT_HOME || '').trim()) return [];
  const old = join(home, '.flintrail');
  const next = join(home, '.rocketwright');
  if (isLink(old) || !isFolder(old) || existsSync(join(next, 'token'))) return [];
  try {
    if (!existsSync(next)) {
      renameSync(old, next);
    } else {
      mkdirSync(next, { recursive: true });
      for (const entry of readdirSync(old)) {
        if (!existsSync(join(next, entry))) renameSync(join(old, entry), join(next, entry));
      }
      if (readdirSync(old).length) return [`left in ${old}: files ${next} already has under the same name`];
      rmdirSync(old);
    }
  } catch (e) {
    return [`could not move ${old} to ${next}: ${(e as Error).message}`];
  }
  try {
    symlinkSync(next, old, 'dir');
  } catch (e) {
    return [`moved ${old} to ${next}, but could not leave a link where it was: ${(e as Error).message}`];
  }
  return [];
}

/** Where Rocketwright keeps its files: the place named, else ~/.rocketwright once it holds the token, else a
 * ~/.flintrail not moved yet (a library use, a test: only the command moves it), else ~/.rocketwright. */
export function resolveHome(home: string, env: NodeJS.ProcessEnv): string {
  const named = (env.ROCKETWRIGHT_HOME || '').trim();
  if (named) return named;
  const next = join(home, '.rocketwright');
  const old = join(home, '.flintrail');
  return !existsSync(join(next, 'token')) && isFolder(old) && !isLink(old) ? old : next;
}

/** Run as a program: the old folder is moved, and what could not be is said. */
export function adoptHome(): void {
  for (const problem of moveHome(homedir(), process.env)) process.stderr.write(`rocketwright: ${problem}\n`);
}

adoptEnvironment(process.env);
