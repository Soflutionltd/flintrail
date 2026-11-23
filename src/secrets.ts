// Every password and one-time code Flintrail filled, masked in all it returns to the agent (tool results,
// console, captured requests), raw or encoded as a form, URL or JSON value would carry it.

/** Secret -> time after which it is no longer masked. One-time codes expire fast and look like ordinary numbers. */
const secrets = new Map<string, number>();

/** Masks this value from now on. Values under 4 characters are not masked: they would mask ordinary text. */
export function remember(s: string, ttl: number) {
  if (s.length >= 4) secrets.set(s, Date.now() + ttl);
}

export function redact(text: string): string {
  let out = text;
  for (const [s, until] of secrets) {
    if (until < Date.now()) {
      secrets.delete(s);
      continue;
    }
    const forms = [s, encodeURIComponent(s), new URLSearchParams({ v: s }).toString().slice(2), JSON.stringify(s).slice(1, -1)];
    for (const f of new Set(forms)) out = out.split(f).join('•••');
  }
  return out;
}
