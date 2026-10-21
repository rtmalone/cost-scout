import type { ToolCallRecord } from '../../../src/agent/run.ts';
import { usd } from './format.ts';

export type CallKind = 'query' | 'finding' | 'error';

const SQL_LABEL_MAX = 60;

function field(input: unknown, key: string): unknown {
  return input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined;
}

function text(input: unknown, key: string): string {
  const v = field(input, key);
  return typeof v === 'string' ? v : '';
}

/** Plain-English label and result for one tool call, as the timing chart shows them. */
export function callLabel(call: ToolCallRecord): { kind: CallKind; label: string; result: string } {
  const { name, input, isError, summary } = call;
  let label: string;
  let result = summary;
  let kind: CallKind = 'query';

  if (name === 'report_finding') {
    const title = text(input, 'title');
    if (isError) {
      label = `Finding rejected: ${title}`;
    } else {
      label = `Reported: ${title}`;
      const savings = field(input, 'estimated_monthly_savings_usd');
      result = `${usd(typeof savings === 'number' ? savings : 0)}/mo`;
      kind = 'finding';
    }
  } else if (name === 'describe_schema') {
    label = 'Read the schema';
    const n = /^\d+/.exec(summary)?.[0];
    if (n && !isError) result = `${n} tables`;
  } else {
    const purpose = text(input, 'purpose').trim();
    const sql = text(input, 'sql').replace(/\s+/g, ' ').trim();
    label = purpose || (sql.length > SQL_LABEL_MAX ? `${sql.slice(0, SQL_LABEL_MAX)}…` : sql);
  }
  return { kind: isError ? 'error' : kind, label, result };
}
