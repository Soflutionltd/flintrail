import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import type { Step } from './engine.js';

export interface Flow {
  name: string;
  description: string;
  startUrl: string | null;
  vars: string[];
  steps: Step[];
  createdAt: string;
  updatedAt: string;
  runs: number;
  lastMs?: number;
  lastOk?: string;
}

const file = (name: string) => join(config.flowsDir, `${name.replace(/[^\w.-]/g, '_')}.json`);

export function saveFlow(flow: Flow) {
  mkdirSync(config.flowsDir, { recursive: true });
  const tmp = file(flow.name) + '.tmp';
  writeFileSync(tmp, JSON.stringify(flow, null, 2));
  renameSync(tmp, file(flow.name));
}

export function loadFlow(name: string): Flow {
  const f = file(name);
  if (!existsSync(f)) throw new Error(`Flow "${name}" does not exist. See fl_flows.`);
  return JSON.parse(readFileSync(f, 'utf8')) as Flow;
}

export function listFlows(): Flow[] {
  if (!existsSync(config.flowsDir)) return [];
  return readdirSync(config.flowsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(config.flowsDir, f), 'utf8')) as Flow);
}
