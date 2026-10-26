import { homedir } from 'node:os';
import { join } from 'node:path';

const env = process.env;
const port = Number(env.FLINTRAIL_PORT || 9222);
const home = env.FLINTRAIL_HOME || join(homedir(), '.flintrail');

export const config = {
  /** attach: drive a running Chrome over CDP. launch: start a dedicated Chromium. */
  mode: (env.FLINTRAIL_MODE === 'launch' ? 'launch' : 'attach') as 'attach' | 'launch',
  port,
  cdpUrl: env.FLINTRAIL_CDP_URL || `http://127.0.0.1:${port}`,
  cdpUrlExplicit: !!env.FLINTRAIL_CDP_URL,
  chromePath: env.FLINTRAIL_CHROME || '',
  headless: env.FLINTRAIL_HEADLESS !== '0',
  allowAnyBrowser: env.FLINTRAIL_ALLOW_ANY_BROWSER === '1',
  home,
  flowsDir: join(home, 'flows'),
  profileDir: env.FLINTRAIL_PROFILE || join(home, 'profile'),
  downloadsDir: env.FLINTRAIL_DOWNLOADS || join(homedir(), 'Downloads', 'Flintrail'),
};
