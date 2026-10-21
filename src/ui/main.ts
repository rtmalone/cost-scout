/** Usage: pnpm ui. Serves the web UI and streams agent runs on 127.0.0.1. */

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_FILENAME, DEFAULT_DATA_DIR } from '../data/generate.ts';
import { ReadOnlyDb } from '../tools/db.ts';
import { createUiServer } from './server.ts';

const problems: string[] = [];
const dbPath = join(DEFAULT_DATA_DIR, DB_FILENAME);
if (!existsSync(dbPath)) problems.push('No dataset found. Run pnpm generate first. Then restart pnpm ui.');
if (!process.env.ANTHROPIC_API_KEY) {
  problems.push('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key. Then restart pnpm ui.');
}

const db = existsSync(dbPath) ? await ReadOnlyDb.open(dbPath) : null;
const port = Number(process.env.COST_SCOUT_UI_PORT ?? 4317);
const server = createUiServer({
  db,
  problems,
  model: process.env.COST_SCOUT_MODEL ?? 'claude-sonnet-5-5',
  staticDir: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'),
});
server.listen(port, '127.0.0.1', () => {
  console.log(`cost-scout UI: http://127.0.0.1:${port}`);
});
