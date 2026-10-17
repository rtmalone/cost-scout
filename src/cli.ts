/**
 * Usage: pnpm scout ["question"]
 */

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILENAME, DEFAULT_DATA_DIR } from './data/generate.ts';
import { runAgent } from './agent/run.ts';
import { ReadOnlyDb } from './tools/db.ts';

const question =
  process.argv.slice(2).join(' ') ||
  'Find the biggest cost-saving opportunities in this environment. For each, show the evidence, the fix, and how to roll it back.';

const dbPath = join(DEFAULT_DATA_DIR, DB_FILENAME);
if (!existsSync(dbPath)) {
  console.error('No dataset found. Run `pnpm generate` first.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const db = await ReadOnlyDb.open(dbPath);
try {
  const result = await runAgent(question, {
    db,
    model: process.env.COST_SCOUT_MODEL ?? 'claude-sonnet-5-5',
    onToolCall: ({ name, input, isError }) => {
      const detail = name === 'run_sql' ? ` ${(input as { purpose?: string }).purpose ?? ''}` : '';
      console.error(`  ${isError ? '✗' : '→'} ${name}${detail}`);
    },
  });

  const total = result.findings.reduce((sum, f) => sum + f.estimated_monthly_savings_usd, 0);
  console.log(`\n${result.findings.length} findings, ~$${total.toFixed(2)}/month\n`);
  for (const [i, f] of result.findings.entries()) {
    console.log(`${i + 1}. [${f.risk}] ${f.title}  ~$${f.estimated_monthly_savings_usd.toFixed(2)}/mo`);
    console.log(`   resources: ${f.resource_ids.join(', ')}`);
    console.log(`   evidence:  ${f.evidence}`);
    console.log(`   change:    ${f.proposed_change}`);
    console.log(`   rollback:  ${f.rollback}`);
    console.log(`   approval:  ${f.approval_notes}\n`);
  }
  if (result.summary) console.log(result.summary);
  console.error(`\n${result.turns} turns, ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`);
} finally {
  db.close();
}
