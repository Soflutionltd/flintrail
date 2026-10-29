// Update notice: tells the agent (and so the user) when a newer version is on npm.
//
// One GET to https://registry.npmjs.org/<package>/latest, a few seconds after start-up.
// Nothing about the machine or its use is sent. Turned off by NO_UPDATE_NOTIFIER=1 or CI.
// The notice is appended once, to the first tool result after a newer version is found.

const REGISTRY = 'https://registry.npmjs.org';

let notice: string | null = null;
let delivered = false;

function parse(v: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `candidate` is a stable release strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

function howToUpdate(repoUrl: string): string {
  return `This copy was started without the auto-updating launcher (for example node dist/... from a git clone). How to install it so it updates itself: ${repoUrl}#install`;
}

/** Only for copies started directly: under the supervisor (bin/supervise.cjs) updates are automatic. */
export function startUpdateCheck(pkg: string, current: string, repoUrl: string): void {
  if (process.env.SOFLUTION_SUPERVISED === '1' || process.env.NO_UPDATE_NOTIFIER || process.env.CI) return;
  const timer = setTimeout(async () => {
    try {
      const res = await fetch(`${REGISTRY}/${encodeURIComponent(pkg)}/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { version?: unknown };
      const latest = typeof body.version === 'string' ? body.version : '';
      if (!isNewer(latest, current)) return;
      notice = `[${pkg}] Update available: ${latest} (running ${current}). Tell the user. ${howToUpdate(repoUrl)}`;
      process.stderr.write(`${notice}\n`);
    } catch {
      // Offline or registry unreachable: stay quiet.
    }
  }, 3000);
  timer.unref();
}

type Sendable = { send: (message: any, options?: any) => Promise<void> };

/** Appends the notice, once, to the first tool result sent after it is known. */
export function attachUpdateNotice<T extends Sendable>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = async (message: any, options?: any) => {
    const content = message?.result?.content;
    if (notice && !delivered && Array.isArray(content)) {
      delivered = true;
      message = { ...message, result: { ...message.result, content: [...content, { type: 'text', text: notice }] } };
    }
    return send(message, options);
  };
  return transport;
}
