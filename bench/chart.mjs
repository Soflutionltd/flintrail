// Renders docs/benchmark.svg from bench/results.json.
import { readFileSync, writeFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8'));
const rows = data.results;
const W = 880, rowH = 58, top = 112, left = 300, barMax = 470;
const H = top + rows.length * rowH + 70;
const max = Math.max(...rows.map((r) => r.medianMs));
const base = rows[0].medianMs;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const bars = rows.map((r, i) => {
  const y = top + i * rowH;
  const w = Math.max(6, (r.medianMs / max) * barMax);
  const ours = !r.label.startsWith('Playwright');
  const fill = ours ? (i === rows.length - 1 ? 'url(#spark)' : '#FF7A2F') : '#8B95A7';
  const speed = r.medianMs < base ? ` · ${(base / r.medianMs).toFixed(1)}× faster` : '';
  return `
  <text x="${left - 16}" y="${y + 22}" text-anchor="end" class="lbl">${esc(r.label)}</text>
  <text x="${left - 16}" y="${y + 40}" text-anchor="end" class="sub">${r.calls} tool calls (model turns)</text>
  <rect x="${left}" y="${y + 8}" width="${w.toFixed(1)}" height="30" rx="7" fill="${fill}" opacity="${ours ? 1 : 0.85}"/>
  <text x="${left + w + 10}" y="${y + 29}" class="val">${r.medianMs.toLocaleString('en-US')} ms<tspan class="gain">${speed}</tspan></text>`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Inter, -apple-system, Segoe UI, Helvetica, Arial, sans-serif">
  <defs>
    <linearGradient id="spark" x1="0" x2="1"><stop offset="0" stop-color="#FF4D00"/><stop offset="1" stop-color="#FFB020"/></linearGradient>
    <style>
      .lbl{font-size:15px;font-weight:600;fill:#E8ECF3}
      .sub{font-size:12px;fill:#8B95A7}
      .val{font-size:15px;font-weight:700;fill:#FFFFFF}
      .gain{font-weight:500;fill:#FFB020}
    </style>
  </defs>
  <rect width="${W}" height="${H}" rx="18" fill="#0E1116"/>
  <text x="32" y="48" font-size="22" font-weight="800" fill="#FFFFFF">Same 5-step task, median of ${data.runs} runs</text>
  <text x="32" y="76" font-size="13.5" fill="#8B95A7">Fill a field, tick a box, change page, click a client-rendered button that calls an API, wait for the result.</text>
  <text x="32" y="95" font-size="13.5" fill="#8B95A7">Tool-side wall time. Every extra tool call also costs one LLM turn, which is not included here.</text>
  ${bars}
  <text x="32" y="${H - 26}" font-size="12" fill="#5C6678">Measured ${data.date.slice(0, 10)} · Node ${data.node} · headless Chromium · bench/bench.mjs reproduces it</text>
</svg>
`;
writeFileSync(new URL('../docs/benchmark.svg', import.meta.url), svg);
console.log('docs/benchmark.svg written');
