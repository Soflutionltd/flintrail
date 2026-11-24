// fl_pdf: the page of a tab as a PDF file, printed by the browser itself (the same engine as its Print dialog).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { config } from './config.js';
import { withSender } from './emulate.js';
import { assertNoSecret, hideForeignFrames } from './engine.js';
import { domainProblem } from './domains.js';

const SIZES = { A4: [8.27, 11.69], Letter: [8.5, 11], A3: [11.69, 16.54], Legal: [8.5, 14] } as const;

export async function savePdf(page: Page, o: { name?: string; landscape?: boolean; format?: keyof typeof SIZES }): Promise<string> {
  // A password or code Flintrail filled could be printed in clear: same rule as a screenshot.
  assertNoSecret(page, 'A PDF');
  const [w, h] = SIZES[o.format || 'A4'];
  // Embedded frames of sites outside the user's list are hidden for the print, as for a screenshot.
  const hidden = await hideForeignFrames(page);
  let out: { data?: string };
  try {
    out = await withSender(page, (send) => send('Page.printToPDF', {
      printBackground: true, landscape: !!o.landscape, paperWidth: w, paperHeight: h,
      marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
    })).catch((e: Error) => {
      throw new Error(/not (implemented|available)|PrintToPDF/i.test(e.message) ? 'This browser cannot print to PDF from a visible window; use the dedicated browser in headless mode.' : `PDF failed: ${e.message.split('\n')[0]}`);
    }) as { data?: string };
  } finally {
    await hidden.restore();
  }
  // The page may have moved to a site outside the list while printing: nothing is kept.
  const away = domainProblem(page.url());
  if (away) throw new Error(`Blocked: the tab left the allowed sites while printing, nothing was saved. ${away}`);
  if (!out?.data) throw new Error('PDF failed: the browser returned nothing.');
  if (out.data.length > 80 * 1024 * 1024) throw new Error('PDF too large (over 60 MB): print a shorter page.');
  const base = (o.name || (await page.title().catch(() => '')) || 'page').replace(/[^\p{L}\p{N} _.-]+/gu, ' ').trim().slice(0, 80) || 'page';
  mkdirSync(config.downloadsDir, { recursive: true });
  // Never over an existing file: "name (2).pdf", "name (3).pdf"...
  let file = join(config.downloadsDir, `${base}.pdf`);
  for (let n = 2; existsSync(file); n++) file = join(config.downloadsDir, `${base} (${n}).pdf`);
  const bytes = Buffer.from(out.data, 'base64');
  writeFileSync(file, bytes, { flag: 'wx' });
  return `PDF saved: ${file} (${Math.round(bytes.length / 1024)} KB).`;
}
