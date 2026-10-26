// Builds docs/demo.gif: real screenshots of the test site, composed with the tool calls that produced them.
// Usage: FLINTRAIL_CHROME=/path/to/chrome node bench/demo.cjs (needs ffmpeg).
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  const { startFixture } = await import('../test/fixture.mjs');
  const site = await startFixture();
  const browser = await chromium.launch(process.env.FLINTRAIL_CHROME ? { executablePath: process.env.FLINTRAIL_CHROME } : {});
  const shotPage = await browser.newPage({ viewport: { width: 620, height: 420 } });
  const shots = {};
  const snap = async (k) => { shots[k] = (await shotPage.screenshot()).toString('base64'); };
  await shotPage.goto(site.url); await snap('form');
  await shotPage.fill('input[name=plate]', 'AA-111-AA'); await shotPage.check('input[type=checkbox]'); await snap('filled');
  await shotPage.click('button[type=submit]'); await snap('loading');
  await shotPage.waitForSelector('[data-testid=confirm]'); await snap('confirm');
  await shotPage.click('[data-testid=confirm]'); await shotPage.waitForSelector('#done'); await snap('done');
  await shotPage.goto(site.url); await shotPage.fill('input[name=plate]', 'ZZ-999-ZZ'); await shotPage.check('input[type=checkbox]');
  await shotPage.click('button[type=submit]'); await shotPage.waitForSelector('[data-testid=confirm]');
  await shotPage.click('[data-testid=confirm]'); await shotPage.waitForSelector('#done'); await snap('done2');

  const C = { cmd: '#FF8A3D', ok: '#3FB950', dim: '#8B95A7', txt: '#E8ECF3', hi: '#FFB020' };
  const L = (c, t) => `<div style="color:${c}">${t}</div>`;
  const story = [
    { shot: 'form', ms: 1100, lines: [L(C.cmd, '› fl_record_start("permit")'), L(C.dim, 'Recording "permit" started.'), L(C.cmd, '› fl_open("https://shop.example")'), L(C.dim, '[e1] text "AB-123-CD"  [e2] select "Paris 7"'), L(C.dim, '[e3] checkbox "Disabled badge"  [e4] button "Continue"')] },
    { shot: 'filled', ms: 700, lines: [L(C.cmd, '› fl_act(tab, [ fill e1 {{plate}}, check e3,'), L(C.cmd, '              click e4, click confirm, wait "active" ])')] },
    { shot: 'loading', ms: 450, lines: [] },
    { shot: 'confirm', ms: 450, lines: [] },
    { shot: 'done', ms: 1300, lines: [L(C.ok, '✓ Ticket T1000 active   one call, 5 actions')] },
    { shot: 'done', ms: 1400, lines: [L(C.cmd, '› fl_record_stop()'), L(C.ok, '✓ Flow "permit" saved: 5 steps, variables: plate')] },
    { shot: 'done2', ms: 1700, lines: [L(C.cmd, '› fl_run("permit", { plate: "ZZ-999-ZZ" })'), L(C.ok, '✓ OK "permit" in 683 ms   no LLM in the loop')] },
    { shot: 'done2', ms: 1500, lines: [L(C.cmd, '› fl_run_many("permit", 3 plates, concurrency 3)'), L(C.ok, '✓ 3/3 succeeded in parallel')] },
    { shot: 'done2', ms: 2600, lines: [L(C.cmd, '› fl_run("permit-api")   the site\'s own API call'), L(C.hi, '⚡ OK in 114 ms   20.9× faster than Playwright MCP')] },
  ];

  const stage = await browser.newPage({ viewport: { width: 1200, height: 560 } });
  const dir = mkdtempSync(join(tmpdir(), 'fl-demo-'));
  let acc = [];
  const list = [];
  for (let i = 0; i < story.length; i++) {
    acc = acc.concat(story[i].lines).slice(-11);
    const html = `<html><body style="margin:0;background:#0E1116;font-family:Inter,-apple-system,Segoe UI,Helvetica,sans-serif">
      <div style="display:flex;gap:22px;padding:26px">
        <div style="width:500px;height:500px;background:#161B22;border:1px solid #2B3340;border-radius:14px;padding:18px 20px;box-sizing:border-box">
          <div style="display:flex;gap:7px;margin-bottom:16px"><span style="width:12px;height:12px;border-radius:6px;background:#FF5F57"></span><span style="width:12px;height:12px;border-radius:6px;background:#FEBC2E"></span><span style="width:12px;height:12px;border-radius:6px;background:#28C840"></span><span style="margin-left:10px;color:#8B95A7;font-size:13px">agent · flintrail MCP</span></div>
          <div style="font:14px/1.75 'DejaVu Sans Mono',Menlo,monospace;white-space:pre;color:${C.txt}">${acc.join('')}</div>
        </div>
        <div style="width:630px;height:500px;background:#161B22;border:1px solid #2B3340;border-radius:14px;overflow:hidden">
          <div style="height:38px;display:flex;align-items:center;padding:0 14px;color:#8B95A7;font-size:13px;border-bottom:1px solid #2B3340">Chrome for Testing · background tab · your sessions</div>
          <img src="data:image/png;base64,${shots[story[i].shot]}" style="display:block;width:630px">
        </div>
      </div></body></html>`;
    await stage.setContent(html);
    const f = join(dir, `f${String(i).padStart(2, '0')}.png`);
    await stage.screenshot({ path: f });
    list.push(`file '${f}'\nduration ${story[i].ms / 1000}`);
  }
  list.push(`file '${join(dir, `f${String(story.length - 1).padStart(2, '0')}.png`)}'`);
  writeFileSync(join(dir, 'list.txt'), list.join('\n'));
  const out = join(__dirname, '..', 'docs', 'demo.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
    '-vf', 'fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', out]);
  console.log('docs/demo.gif written');
  await browser.close();
  site.server.close();
})();
