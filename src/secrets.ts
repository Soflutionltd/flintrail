// Every password and one-time code Rocketwright filled, masked in all it returns to the agent (tool results,
// console, captured requests), raw or encoded as a form, URL or JSON value would carry it.

/** Secret -> time after which it is no longer masked. One-time codes expire fast and look like ordinary numbers. */
const secrets = new Map<string, number>();

/** Masks this value from now on. Values under 4 characters are not masked: they would mask ordinary text. */
export function remember(s: string, ttl: number) {
  if (s.length >= 4) secrets.set(s, Date.now() + ttl);
}

/**
 * Values that look like credentials, wherever they come from (a page showing a freshly created API key in its
 * buttons, a script the agent ran): masked in everything returned to the agent, whether or not Rocketwright
 * filled them. Only the user can turn this off, in Rocketwright's settings (ROCKETWRIGHT_MASK_SECRETS=off), never a tool.
 */
const KNOWN_PREFIXES = /(?<![A-Za-z0-9])(?:github_pat_|gh[pousr]_|glpat-|xox[abpors]-|sk_(?:live|test)_|rk_(?:live|test)_|whsec_|cfut_|cfat_|AIza|ya29\.|npm_|pypi-|dop_v1_|shpat_|SG\.)[A-Za-z0-9_\-.]{12,}/g;
const LONG_PREFIXES = /(?<![A-Za-z0-9])(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9]))/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// A long run of letters AND digits shortly after a word that announces a secret ("Secret Access Key", "jeton").
// Not a path or a URL ("/"), not plain words: a token has both letters and digits.
const NEAR_WORD = /((?:secret|private|access|api|auth|bearer|session|client|credential|password|passwd|token|key|cl[ée]|jeton|mot de passe)[^\n]{0,48}?)([A-Za-z0-9+_=-]{32,})/gi;
const MASK = '••• (secret masked)';

/** A guard against secrets shown by accident, not a wall against a hostile agent (a value can be split or encoded). */
export function maskSecrets(text: string): string {
  if (process.env.ROCKETWRIGHT_MASK_SECRETS === 'off') return text;
  return text.replace(KNOWN_PREFIXES, MASK).replace(LONG_PREFIXES, MASK).replace(JWT, MASK)
    .replace(NEAR_WORD, (all: string, before: string, token: string) => (/[A-Za-z]/.test(token) && /\d/.test(token) ? `${before}${MASK}` : all));
}

export function redact(text: string): string {
  let out = maskSecrets(text);
  for (const [s, until] of secrets) {
    if (until < Date.now()) {
      secrets.delete(s);
      continue;
    }
    const forms = [s, encodeURIComponent(s), new URLSearchParams({ v: s }).toString().slice(2), JSON.stringify(s).slice(1, -1)];
    for (const f of new Set(forms)) out = out.split(f).join('•••');
    // A long secret shown cut short (a field value, a text excerpt): its start is masked with what follows it.
    if (s.length >= 16) out = out.replace(new RegExp(s.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\S*', 'g'), '•••');
  }
  return out;
}

/** Whether a text holds a password, code or secret Rocketwright filled, pasted or captured, in any form redact knows. */
export function holdsRemembered(text: string): boolean {
  const now = Date.now();
  for (const [s, until] of secrets) {
    if (until < now) continue;
    const forms = [s, encodeURIComponent(s), new URLSearchParams({ v: s }).toString().slice(2), JSON.stringify(s).slice(1, -1)];
    if (forms.some((f) => text.includes(f))) return true;
  }
  return false;
}
