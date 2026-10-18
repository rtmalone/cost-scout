/**
 * The agent's three tools: definitions (what the model sees) and handlers
 * (what actually runs). The agent can look and propose. It cannot change
 * anything: there is no tool that executes a fix.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { FINDING_CATEGORIES, RISK_LEVELS, type Finding } from '../findings.ts';
import { ANALYSIS_DATE, PERIOD_DAYS, PERIOD_START } from '../data/scenario.ts';
import type { ReadOnlyDb } from './db.ts';

export interface ToolContext {
  db: ReadOnlyDb;
  findings: Finding[];
}

export interface ToolOutcome {
  /** What the model sees. */
  content: string;
  isError: boolean;
  /** One line for the audit log, e.g. "12 rows" or "Recorded finding #2: ...". */
  summary?: string;
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'describe_schema',
    description:
      'Describe the tables available for analysis: columns, types, row counts, the billing period, and the distinct metric names. Call this first.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'run_sql',
    description:
      'Run one read-only DuckDB SELECT query and get the results as JSON. Results are capped at 200 rows, so aggregate in SQL instead of pulling raw rows. JSON columns (Tags, tags, attributes) can be read with ->> (e.g. Tags->>\'env\').',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single DuckDB SELECT statement.' },
        purpose: { type: 'string', description: 'One line on what this query is meant to show.' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'report_finding',
    description:
      'Record one cost-saving finding. Only report findings backed by query results. Every resource_id must exist in the data. Group resources that share one root cause and one fix into a single finding.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        category: { type: 'string', enum: [...FINDING_CATEGORIES] },
        resource_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        evidence: { type: 'string', description: 'The specific numbers from your queries that justify this finding.' },
        estimated_monthly_savings_usd: { type: 'number', minimum: 0 },
        proposed_change: { type: 'string', description: 'The exact change: CLI command, IaC diff, or console steps.' },
        rollback: { type: 'string', description: 'How to undo the change if it turns out to be wrong.' },
        risk: { type: 'string', enum: [...RISK_LEVELS] },
        approval_notes: { type: 'string', description: 'Who should approve, and what they should confirm first.' },
      },
      required: [
        'title',
        'category',
        'resource_ids',
        'evidence',
        'estimated_monthly_savings_usd',
        'proposed_change',
        'rollback',
        'risk',
        'approval_notes',
      ],
    },
  },
];

const TABLE_NOTES: Record<string, string> = {
  billing:
    'Cost and usage data using a subset of FOCUS 1.4 columns, one row per resource per day. EffectiveCost is the amortized cost to use for savings math.',
  resources: 'Inventory snapshot as of the analysis date: configuration (attributes) and tags for every resource.',
  resource_metrics:
    'Daily utilization metrics (long format: metric_name, value, unit). Not every resource has metrics; storage-only resources often have none.',
};

async function describeSchema(ctx: ToolContext): Promise<ToolOutcome> {
  const sections: string[] = [
    `Billing period: ${PERIOD_DAYS} days starting ${PERIOD_START}. Analysis date: ${ANALYSIS_DATE}.`,
  ];
  for (const [table, note] of Object.entries(TABLE_NOTES)) {
    const cols = await ctx.db.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`,
    );
    const count = await ctx.db.query(`SELECT count(*) AS n FROM ${table}`);
    if (!cols.ok || !count.ok) return { content: `Failed to describe ${table}.`, isError: true };
    const columnList = cols.rows.map((c) => `  ${c.column_name} ${c.data_type}`).join('\n');
    sections.push(`## ${table} (${count.rows[0]?.n} rows)\n${note}\n${columnList}`);
  }
  const metrics = await ctx.db.query(
    'SELECT metric_name, any_value(unit) AS unit, count(DISTINCT resource_id) AS resources FROM resource_metrics GROUP BY 1 ORDER BY 1',
  );
  if (metrics.ok) {
    sections.push(
      '## metric names\n' + metrics.rows.map((m) => `  ${m.metric_name} (${m.unit}, ${m.resources} resources)`).join('\n'),
    );
  }
  return { content: sections.join('\n\n'), isError: false, summary: `${Object.keys(TABLE_NOTES).length} tables described` };
}

async function runSql(input: { sql?: unknown }, ctx: ToolContext): Promise<ToolOutcome> {
  if (typeof input.sql !== 'string' || input.sql.trim() === '') {
    return { content: 'sql must be a non-empty string.', isError: true };
  }
  const result = await ctx.db.query(input.sql);
  if (!result.ok) return { content: result.error, isError: true };
  return {
    content: JSON.stringify({
      columns: result.columns,
      rows: result.rows,
      row_count: result.rowCount,
      truncated: result.truncated,
    }),
    isError: false,
    summary: `${result.rowCount} rows${result.truncated ? ' (truncated)' : ''}`,
  };
}

async function reportFinding(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const problems: string[] = [];
  const str = (key: string) => {
    if (typeof input[key] !== 'string' || (input[key] as string).trim() === '') problems.push(`${key} is required`);
  };
  ['title', 'evidence', 'proposed_change', 'rollback', 'approval_notes'].forEach(str);
  if (!FINDING_CATEGORIES.includes(input.category as never)) problems.push(`category must be one of ${FINDING_CATEGORIES.join(', ')}`);
  if (!RISK_LEVELS.includes(input.risk as never)) problems.push(`risk must be one of ${RISK_LEVELS.join(', ')}`);
  const savings = input.estimated_monthly_savings_usd;
  if (typeof savings !== 'number' || !Number.isFinite(savings) || savings < 0) {
    problems.push('estimated_monthly_savings_usd must be a non-negative number');
  }
  const ids = input.resource_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) {
    problems.push('resource_ids must be a non-empty array of strings');
  } else {
    // Guard against a classic agent failure: confidently citing a resource that doesn't exist.
    const known = await ctx.db.knownResourceIds(ids);
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) problems.push(`unknown resource_ids (not in resources or billing): ${unknown.join(', ')}`);
  }
  if (problems.length) {
    return { content: `Finding rejected:\n- ${problems.join('\n- ')}\nFix these and report it again.`, isError: true };
  }

  ctx.findings.push(input as unknown as Finding);
  return { content: `Recorded finding #${ctx.findings.length}: ${input.title}`, isError: false };
}

export async function handleToolCall(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'describe_schema':
        return await describeSchema(ctx);
      case 'run_sql':
        return await runSql(args, ctx);
      case 'report_finding':
        return await reportFinding(args, ctx);
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `Tool ${name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}
