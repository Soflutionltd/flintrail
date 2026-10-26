#!/usr/bin/env node
// Builds the .mcpb bundle (Claude Desktop extension, MCP Registry package) from .mcp/manifest.json.
// Usage: node scripts/build-mcpb.mjs [version]   (defaults to package.json's version)
// The project must already be built (dist/). Output: <name>-<version>.mcpb in the project root.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, chmodSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = (process.argv[2] || pkg.version).replace(/^v/, '');
const manifest = JSON.parse(readFileSync(join(root, '.mcp/manifest.json'), 'utf8'));
manifest.version = version;
const out = join(root, 'mcpb-bundle');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['dist', 'README.md', 'LICENSE', 'vendor']) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(out, f), { recursive: true });
}
if (existsSync(join(root, '.mcp/icon.png'))) {
  copyFileSync(join(root, '.mcp/icon.png'), join(out, 'icon.png'));
  manifest.icon = 'icon.png';
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
// Production dependencies only, installed as real files (file: dependencies included).
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: pkg.name, version, type: pkg.type || 'commonjs', private: true, dependencies: pkg.dependencies || {},
}, null, 2));
run('npm install --omit=dev --install-links --no-audit --no-fund --ignore-scripts=false', out);

// One bundle for every platform: ripgrep binaries for all of them, picked at runtime.
const rgScript = join(root, 'scripts/download-all-ripgrep.cjs');
if (existsSync(rgScript) && existsSync(join(out, 'node_modules/@vscode/ripgrep'))) {
  run(`node ${rgScript}`);
  const src = join(root, 'node_modules/@vscode/ripgrep/bin');
  const dest = join(out, 'node_modules/@vscode/ripgrep/bin');
  mkdirSync(dest, { recursive: true });
  for (const b of readdirSync(src).filter((f) => f.startsWith('rg-'))) {
    copyFileSync(join(src, b), join(dest, b));
    if (!b.endsWith('.exe')) chmodSync(join(dest, b), 0o755);
  }
  copyFileSync(join(root, 'scripts/ripgrep-wrapper.js'), join(out, 'node_modules/@vscode/ripgrep/lib/index.js'));
}
// sharp: keep the WebAssembly build as a fallback on platforms without their native package.
if (existsSync(join(out, 'node_modules/sharp')) && !existsSync(join(out, 'node_modules/@img/sharp-wasm32'))) {
  run('npm install --no-save --no-audit --no-fund --force @img/sharp-wasm32', out);
}

const file = `${manifest.name}-${version}.mcpb`;
run(`npx -y @anthropic-ai/mcpb@2 validate "${join(out, 'manifest.json')}"`);
run(`npx -y @anthropic-ai/mcpb@2 pack "${out}" "${join(root, file)}"`);
console.log(file);
