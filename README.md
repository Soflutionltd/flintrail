<p align="center">
  <img src="docs/logo.svg" alt="Flintrail" width="420">
</p>

<h3 align="center">The fastest browser for AI agents.</h3>

<p align="center">
  Drive a real Chrome live. Record a task once. Replay it in milliseconds, with no LLM in the loop.<br>
  Or skip the page entirely and replay the site's own API calls with your session.
</p>

<p align="center">
  <a href="https://github.com/Soflutionltd/flintrail/actions/workflows/ci.yml"><img src="https://github.com/Soflutionltd/flintrail/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-FF6A1A" alt="MCP">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-3FB950" alt="Node 20+">
  <img src="https://img.shields.io/badge/license-MIT-8B95A7" alt="MIT">
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Flintrail demo: record a flow, replay it in 773 ms, replay its API call in 127 ms" width="900">
</p>

---

## Why

Browser MCP servers today make the model do everything, every time: read the page, pick one element, click, read the page again. Each click is a tool call, and each tool call is a model turn that costs seconds. Do the same task tomorrow and the agent pays the full price again.

Flintrail treats the browser like a JIT compiler treats code:

1. **Live**, the agent drives the page, but batches a whole sequence of actions into one call and gets back a compact snapshot with clickable refs.
2. **Record**, the same calls are captured with multi-clue element fingerprints and `{{variables}}`.
3. **Replay**, the flow runs at browser speed with no model between steps. When a site changes, the run stops at the exact failing step and hands the page back so the agent repairs only that part.
4. **API replay**, Flintrail sees the site's own fetch/XHR calls and can replay them from inside the page, with the same cookies and session. No rendering, no clicking.

## Benchmark

<p align="center"><img src="docs/benchmark.svg" alt="Benchmark" width="880"></p>

Same 5-step task (fill a field, tick a box, change page, click a client-rendered button that calls an API, wait for the result), median of 10 runs, headless Chromium. The numbers are tool-side wall time only. In a real agent every tool call also costs a model turn, so going from 7 calls to 2 saves several more seconds on top.

Reproduce it: `npm run bench` (installs nothing global; Playwright MCP is a dependency of `bench/` only).

## Architecture

<p align="center"><img src="docs/architecture.svg" alt="Architecture" width="900"></p>

## Install

```bash
git clone https://github.com/Soflutionltd/flintrail.git
cd flintrail && npm install && npm run build
```

### Claude Desktop, Claude Code, Cursor (stdio)

```json
{
  "mcpServers": {
    "flintrail": {
      "command": "node",
      "args": ["/absolute/path/to/flintrail/dist/cli.js"]
    }
  }
}
```

Claude Code: `claude mcp add flintrail -- node /absolute/path/to/flintrail/dist/cli.js`

### Any agent, any machine (HTTP)

```bash
node dist/cli.js --http --host 127.0.0.1 --port 8931
# token is generated once in ~/.flintrail/token (or pass --token / FLINTRAIL_TOKEN)
```

Clients connect to `http://host:8931/mcp` with `Authorization: Bearer <token>`. Put it behind a tunnel or reverse proxy with TLS if it leaves the machine.

## Browser modes

| Mode | When | How |
|---|---|---|
| `attach` (default) | Your desktop. Keep your logged-in sessions. | Connects over CDP to a dedicated **Chrome for Testing**. On macOS Flintrail finds it, restarts it with a local debugging port if needed (tabs are restored) and opens its own tabs in the background. |
| `launch` | Servers, CI, Docker. | `FLINTRAIL_MODE=launch` starts Chromium with a persistent profile in `~/.flintrail/profile`, headless by default. |

Flintrail refuses to attach to a personal browser (Brave, Edge, Opera, or on macOS anything that is not Chrome for Testing) unless `FLINTRAIL_ALLOW_ANY_BROWSER=1`. Your everyday browser stays yours.

## Tools

| Tool | What it does |
|---|---|
| `fl_open` | Open a URL in a background tab, return a compact snapshot with `[eN]` refs. |
| `fl_act` | Run many actions in one call: `click`, `fill`, `type`, `select`, `check`, `press`, `download`, `goto`, `wait`, `scroll`, `eval`, `request`. |
| `fl_snapshot` | Re-read a page: interactive elements, headings, text excerpt, same-origin frames. |
| `fl_extract` | Run JavaScript in the page and return the result. |
| `fl_network` | List the site's own API calls with timing, body and a JSON sample. |
| `fl_screenshot` | JPEG screenshot when layout matters. |
| `fl_record_start` / `fl_record_stop` | Record a flow; `repairFrom` keeps the good steps and re-records the rest. |
| `fl_run` | Replay a flow with variables, no LLM. |
| `fl_run_many` | Replay a flow for many variable sets in parallel tabs. |
| `fl_flows` / `fl_flow` | List flows, inspect one. |
| `fl_tabs` / `fl_close` | Manage tabs. |

### Example

```jsonc
// one call, five actions
{ "tool": "fl_act", "tab": "t1", "actions": [
  { "do": "fill",  "ref": "e1", "value": "AA-111-AA", "var": "plate" },
  { "do": "check", "ref": "e3" },
  { "do": "click", "role": "button", "name": "Continue" },
  { "do": "click", "selector": "[data-testid=confirm]" },
  { "do": "wait",  "text": "active" }
]}
```

Then `fl_run("permit", { "plate": "ZZ-999-ZZ" })` repeats it in under a second.

## How replay finds elements again

Each recorded step stores a fingerprint, not a fragile selector: test id, stable id, `name` attribute, ARIA role and accessible name, placeholder, link target, visible text and a short CSS path. At replay time Flintrail tries them from most to least stable and takes the first that matches exactly one element, waiting only for that element, never for the network to go idle.

## Security

- No password is ever written to a flow. Password fields are skipped during recording; keep the session logged in instead.
- Flows are plain JSON in `~/.flintrail/flows`, easy to review and version.
- The HTTP transport requires a bearer token (constant-time comparison) and binds to `127.0.0.1` by default.
- `eval` and `request` run inside the page with the page's own privileges, nothing more.

## Configuration

| Variable | Default | |
|---|---|---|
| `FLINTRAIL_MODE` | `attach` | `attach` or `launch` |
| `FLINTRAIL_CDP_URL` | `http://127.0.0.1:9222` | Browser to attach to |
| `FLINTRAIL_PORT` | `9222` | Debugging port used when Flintrail starts Chrome for Testing |
| `FLINTRAIL_CHROME` | auto | Browser executable |
| `FLINTRAIL_HEADLESS` | `1` | `0` to see the window in launch mode |
| `FLINTRAIL_HOME` | `~/.flintrail` | Flows, profile, token |
| `FLINTRAIL_DOWNLOADS` | `~/Downloads/Flintrail` | Where downloads land |
| `FLINTRAIL_TOKEN` | generated | HTTP bearer token |

## Develop

```bash
npm install
npx playwright-core install chromium   # once, for tests
npm test                               # build + 9 end-to-end tests over real MCP
npm run bench                          # benchmark vs Playwright MCP
```

## Roadmap

- Automatic promotion of recorded UI steps to API steps when the captured call is replay-safe.
- Shared flow library for common sites.
- Visual diff on replay failure.

## En français

Flintrail est un serveur MCP de navigation pour agents IA. Il pilote un vrai Chrome dédié (jamais votre navigateur personnel), enchaîne plusieurs actions en un seul appel, enregistre une tâche la première fois puis la rejoue seul, sans IA, en quelques centaines de millisecondes, ou en rejouant directement les appels API du site avec votre session. Sur notre banc d'essai, la même tâche prend 2,4 s avec Playwright MCP et 0,13 s avec Flintrail en mode API.

## License

MIT © 2026 Soflution Ltd
