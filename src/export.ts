// fl_flow_export: a recorded flow as a Playwright Test file (@playwright/test), to run in a project's own test suite
// with `npx playwright test`, in Chromium, Firefox or WebKit. Variables come from environment variables; a sign-in
// step reads its username and password from LOGIN_USERNAME and LOGIN_PASSWORD. No value Flintrail kept out of the
// flow (a password) is in it.
import type { Step } from './engine.js';
import type { TargetDescriptor } from './page-scripts.js';
import { loadFlow } from './store.js';
import { VERSION } from './version.js';

const q = (s: string) => JSON.stringify(s);
/** Text for a // comment: a line break of any kind would end the comment and turn the rest into code. */
/** A number from the flow file, written as a number whatever the file holds. */
const n = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
const comment = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ');
/** A recorded string, with {{var}} read from the environment at run time. */
const val = (s: string | undefined) => (s === undefined ? 'undefined' : /\{\{\w+\}\}/.test(s) ? `v(${q(s)})` : q(s));
const css = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const unstableId = (id: string) => /\d{3,}|[a-f0-9]{8,}|:/.test(id);

/** The most stable locator for a recorded element, in the order Flintrail itself tries them. */
function locator(d: TargetDescriptor): string {
  const root = d.frameUrl ? `frame(page, ${q(d.frameUrl)})` : 'page';
  if (d.testid) return `${root}.locator(${q(`[data-testid="${css(d.testid)}"],[data-test="${css(d.testid)}"],[data-qa="${css(d.testid)}"]`)})`;
  if (d.id && !unstableId(d.id)) return `${root}.locator(${q(`[id="${css(d.id)}"]`)})`;
  if (d.nameAttr) return `${root}.locator(${q(`${d.tag}[name="${css(d.nameAttr)}"]`)})`;
  if (d.role && d.name) return `${root}.getByRole(${q(d.role)}, { name: ${q(d.name)}, exact: true })`;
  if (d.placeholder) return `${root}.getByPlaceholder(${q(d.placeholder)}, { exact: true })`;
  if (d.href && d.tag === 'a') return `${root}.locator(${q(`a[href="${css(d.href)}"]`)})`;
  if (d.text && d.text.length < 60) return `${root}.locator(${q(d.tag)}).filter({ hasText: ${q(d.text)} })`;
  return `${root}.locator(${q(d.css)})`;
}

/** A page-level target given by selector, role, label, placeholder or text (wait steps). */
function pageTarget(s: Step): string | null {
  if (s.selector) return `page.locator(${q(s.selector)}).first()`;
  if (s.role) return `page.getByRole(${q(s.role)}${s.name ? `, { name: ${val(s.name)} }` : ''}).first()`;
  if (s.label) return `page.getByLabel(${val(s.label)}).first()`;
  if (s.placeholder) return `page.getByPlaceholder(${val(s.placeholder)}).first()`;
  if (s.text) return `page.getByText(${val(s.text)}).first()`;
  return null;
}

function stepCode(s: Step, i: number): string[] {
  const at = `// step ${i}: ${s.do}`;
  if (s.do === 'login') {
    return [at + (s.item ? comment(` (${s.source} login "${s.item}")`) : ''), `await signIn(page${s.submit === false ? ', false' : ''});`];
  }
  if (s.target) {
    const el = locator(s.target);
    switch (s.do) {
      case 'click': return [at, `await ${el}.click();`];
      case 'dblclick': return [at, `await ${el}.dblclick();`];
      case 'hover': return [at, `await ${el}.hover();`];
      case 'fill': return [at, `await ${el}.fill(${val(s.value ?? '')});`];
      case 'type': return [at, `await ${el}.pressSequentially(${val(s.value ?? '')}, { delay: 25 });`];
      case 'select': return [at, `await ${el}.selectOption(${val(s.value ?? '')});`];
      case 'check': return [at, `await ${el}.check();`];
      case 'uncheck': return [at, `await ${el}.uncheck();`];
      case 'press': return [at, `await ${el}.press(${q(s.key || 'Enter')});`];
      case 'drag':
        if (!s.toTarget) throw new Error(`step ${i} (drag) has no recorded drop target.`);
        return [at, `await ${el}.dragTo(${locator(s.toTarget)});`];
      case 'download':
        return [at, '{', `  const [download] = await Promise.all([page.waitForEvent('download'), ${el}.click()]);`,
          '  await download.saveAs(test.info().outputPath(download.suggestedFilename()));', '}'];
      case 'upload':
        return [at, `await upload(page, ${el}, [${(s.files || []).map(val).join(', ')}]);`];
      default: throw new Error(`step ${i}: "${s.do}" on an element is not something Playwright Test can replay.`);
    }
  }
  switch (s.do) {
    case 'goto': return [at, `await page.goto(${val(s.url)});`];
    case 'back': return [at, 'await page.goBack();'];
    case 'press': return [at, `await page.keyboard.press(${q(s.key || 'Enter')});`];
    case 'scroll': return [at, `await page.mouse.wheel(0, ${n(s.y, 800)});`];
    case 'mouse':
      if (typeof s.x !== 'number' || typeof s.y !== 'number') throw new Error(`step ${i} (mouse) has no x and y.`);
      return [at, `await page.mouse.click(${n(s.x, 0)}, ${n(s.y, 0)}${s.count ? `, { clickCount: ${n(s.count, 1)} }` : ''});`];
    case 'resize': return [at, `await page.setViewportSize({ width: ${n(s.width, 1280)}, height: ${n(s.height, 800)} });`];
    case 'dialog':
      return [at, `page.once('dialog', (d) => ${s.accept === false ? 'd.dismiss()' : `d.accept(${s.value !== undefined ? val(s.value) : ''})`});`];
    case 'wait': {
      const target = pageTarget(s);
      const timeout = s.ms ? `, timeout: ${n(s.ms, 15000)}` : '';
      if (target) return [at, `await ${target}.waitFor({ state: ${q(s.state || 'visible')}${timeout} });`];
      if (s.url) return [at, `await page.waitForURL(new RegExp(${val(s.url)})${s.ms ? `, { timeout: ${n(s.ms, 15000)} }` : ''});`];
      if (s.network) return [at, `await page.waitForLoadState('networkidle'${s.ms ? `, { timeout: ${n(s.ms, 15000)} }` : ''});`];
      return [at, `await page.waitForTimeout(${n(s.ms, 1000) || 1000});`];
    }
    case 'eval':
      return [at, `await page.evaluate(${val(`(async () => { ${s.js || 'return null'} })()`)});`];
    case 'request':
      return [at, `await request(page, ${q((s.method || 'GET').toUpperCase())}, ${val(s.url)}, ${s.body !== undefined ? val(s.body) : 'undefined'}, ${s.headers ? JSON.stringify(s.headers) : 'undefined'});`];
    default: throw new Error(`step ${i}: "${s.do}" is not something Playwright Test can replay.`);
  }
}

/** The flow as the text of a .spec.ts file. */
export function exportFlow(name: string): string {
  const flow = loadFlow(name);
  const desktop = flow.steps.map((s, i) => (s.do === 'desktop' ? i : -1)).filter((i) => i >= 0);
  if (desktop.length) {
    throw new Error(`Flow "${name}" drives desktop apps (step${desktop.length > 1 ? 's' : ''} ${desktop.join(', ')}), which Playwright Test cannot replay. Record the browser part as its own flow to export it.`);
  }
  const body: string[] = [];
  if (flow.startUrl) body.push('// start', `await page.goto(${val(flow.startUrl)});`);
  flow.steps.forEach((s, i) => body.push(...stepCode(s, i)));
  const all = JSON.stringify(flow);
  const uses = (what: string) => body.some((l) => l.includes(what));
  const vars = flow.vars.filter((v) => v !== 'password');
  const env = (v: string) => `FLOW_${v.replace(/\W/g, '_').toUpperCase()}`;
  const head = [
    `// Flow ${comment(q(flow.name))} recorded with Flintrail ${VERSION}, exported ${new Date().toISOString().slice(0, 10)}.`,
    ...(flow.description ? [`// ${comment(flow.description)}`] : []),
    '// Run it with: npx playwright test <this file>   (any browser: --project=chromium, firefox or webkit)',
    ...(vars.length ? [`// Variables, from the environment: ${vars.map((v) => `${env(v)} ({{${v}}})`).join(', ')}.`] : []),
    ...(uses('signIn(') ? ['// Sign-in: LOGIN_USERNAME and LOGIN_PASSWORD (never written in this file).'] : []),
  ];
  const helpers: string[] = [];
  if (/\{\{\w+\}\}/.test(all)) {
    helpers.push(
      '/** A recorded value with its {{variables}} read from the environment. */',
      'function v(s: string): string {',
      `  return s.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k: string) => {`,
      "    const name = `FLOW_${k.replace(/\\W/g, '_').toUpperCase()}`;",
      '    const value = process.env[name];',
      '    if (value === undefined) throw new Error(`Set ${name} for {{${k}}}.`);',
      '    return value;',
      '  });',
      '}',
      '',
    );
  }
  if (uses('frame(page')) {
    helpers.push(
      '/** An embedded frame, by its address without the query string. */',
      'function frame(page: Page, url: string) {',
      "  const found = page.frames().find((f) => f.url().split('?')[0] === url);",
      '  if (!found) throw new Error(`No frame at ${url}.`);',
      '  return found;',
      '}',
      '',
    );
  }
  if (uses('signIn(')) {
    helpers.push(
      '/** Fills the visible sign-in form: username (when the page asks for it), then password. */',
      'async function signIn(page: Page, submit = true) {',
      '  const username = process.env.LOGIN_USERNAME;',
      '  const password = process.env.LOGIN_PASSWORD;',
      "  if (!password) throw new Error('Set LOGIN_PASSWORD (and LOGIN_USERNAME) for the sign-in step.');",
      "  const user = page.locator('input[autocomplete=username], input[type=email], input[name*=user i], input[name*=login i], input[name*=email i], input[id*=user i], input[id*=email i]').filter({ visible: true }).first();",
      '  if (username && await user.count()) {',
      '    await user.fill(username);',
      "    const pass = page.locator('input[type=password]').filter({ visible: true });",
      "    if (!await pass.count()) { await user.press('Enter'); await pass.first().waitFor(); }",
      '  }',
      "  const pass = page.locator('input[type=password]').filter({ visible: true }).first();",
      '  await pass.fill(password);',
      "  if (submit) await pass.press('Enter');",
      '}',
      '',
    );
  }
  if (uses('upload(')) {
    helpers.push(
      '/** Files into a file input, or through the file chooser a button or drop zone opens. */',
      'async function upload(page: Page, target: Locator, files: string[]) {',
      "  if (await target.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file')) return target.setInputFiles(files);",
      "  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), target.click()]);",
      '  await chooser.setFiles(files);',
      '}',
      '',
    );
  }
  if (uses('request(page')) {
    helpers.push(
      '/** A request sent from the page, with its cookies, as Flintrail sends it. */',
      'async function request(page: Page, method: string, url: string, body?: string, headers?: Record<string, string>) {',
      '  const status = await page.evaluate(async ([method, url, body, headers]) => {',
      "    const r = await fetch(url as string, { method: method as string, body: body as string | undefined, headers: headers as Record<string, string> | undefined, credentials: 'include' });",
      '    return r.status;',
      '  }, [method, url, body, headers] as const);',
      '  if (status >= 400) throw new Error(`HTTP ${status} on ${method} ${url}`);',
      '}',
      '',
    );
  }
  // Only the types the helpers use: no unused import for the project's linter to flag.
  const types = [helpers.some((l) => l.includes('Page')) ? 'type Page' : '', uses('upload(') ? 'type Locator' : ''].filter(Boolean).sort();
  const imports = [`import { test${types.map((t) => `, ${t}`).join('')} } from '@playwright/test';`, ''];
  const test = [
    `test(${q(flow.name)}, async ({ page }) => {`,
    ...body.map((l) => `  ${l}`),
    '});',
    '',
  ];
  return [...head, ...imports, ...helpers, ...test].join('\n');
}
