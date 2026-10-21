import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_QUESTION, type MessagesClient } from '../src/agent/run.ts';
import { generate } from '../src/data/generate.ts';
import { ReadOnlyDb } from '../src/tools/db.ts';
import type { RunEvent } from '../src/ui/events.ts';
import { runSession } from '../src/ui/session.ts';
import { monthlySpend } from '../src/ui/spend.ts';

let dir: string;
let db: ReadOnlyDb;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cost-scout-ui-test-'));
  const { dbPath } = await generate({ dataDir: dir, groundTruthPath: join(dir, 'ground-truth.json') });
  db = await ReadOnlyDb.open(dbPath);
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

// --- A scripted stand-in for the Anthropic client ---------------------------

type Step = Anthropic.Message | ((body: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message);

/**
 * The message rules the API enforces on every request. The fake client checks them, so a loop
 * that drops or reorders a tool_result fails here the way it would fail against the real API.
 */
function checkMessageRules(messages: Anthropic.MessageParam[]) {
  const blocks = (m: Anthropic.MessageParam | undefined) => (m && Array.isArray(m.content) ? m.content : []);
  messages.forEach((m, i) => {
    const expected = i % 2 === 0 ? 'user' : 'assistant';
    if (m.role !== expected) throw new Error(`messages[${i}] should be ${expected}, got ${m.role}`);

    if (m.role === 'user') {
      const content = blocks(m);
      const firstOther = content.findIndex((b) => b.type !== 'tool_result');
      const results = content.filter((b) => b.type === 'tool_result');
      if (firstOther !== -1 && content.slice(firstOther).some((b) => b.type === 'tool_result')) {
        throw new Error(`messages[${i}]: tool_result blocks must come first`);
      }
      const asked = blocks(messages[i - 1]).filter((b) => b.type === 'tool_use').map((b) => b.id);
      const answered = results.map((b) => b.tool_use_id);
      const orphans = answered.filter((id) => !asked.includes(id));
      if (orphans.length) throw new Error(`messages[${i}]: tool_result without a tool_use: ${orphans.join(', ')}`);
      for (const id of asked) {
        const n = answered.filter((a) => a === id).length;
        if (n !== 1) throw new Error(`messages[${i}]: tool_use ${id} has ${n} tool_results, expected 1`);
      }
    } else if (blocks(m).some((b) => b.type === 'tool_use') && i === messages.length - 1) {
      throw new Error(`messages[${i}]: tool_use with no tool_result after it`);
    }
  });
}

/** Replays scripted responses in order, checks each request, and records a snapshot of it. */
function fakeClient(steps: Step[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(body) {
        checkMessageRules(body.messages);
        requests.push(structuredClone(body));
        const step = steps[requests.length - 1];
        if (!step) throw new Error(`fake client: no response scripted for request ${requests.length}`);
        return typeof step === 'function' ? step(body) : step;
      },
    },
  };
  return { client, requests };
}

let nextId = 0;

function message(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.StopReason,
  usage: Partial<Anthropic.Usage> = {},
): Anthropic.Message {
  return {
    id: `msg_${++nextId}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    container: null,
    diagnostics: null,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      ...usage,
    },
  };
}

const text = (t: string): Anthropic.TextBlock => ({ type: 'text', text: t, citations: null });

const toolUse = (name: string, input: unknown): Anthropic.ToolUseBlock => ({
  type: 'tool_use',
  id: `toolu_${++nextId}`,
  name,
  input,
  caller: { type: 'direct' },
});

const finding = {
  title: 'Idle instance',
  category: 'compute',
  resource_ids: ['i-0e8f7a6b5c4d30031'],
  evidence: 'CPU averaged 1.2% over 90 days',
  estimated_monthly_savings_usd: 276.48,
  proposed_change: 'aws ec2 stop-instances --instance-ids i-0e8f7a6b5c4d30031',
  rollback: 'aws ec2 start-instances --instance-ids i-0e8f7a6b5c4d30031',
  risk: 'low',
  approval_notes: 'Confirm with the owner',
};

async function collect(question: string, client: MessagesClient, signal = new AbortController().signal) {
  const events: RunEvent[] = [];
  await runSession(question, { db, model: 'claude-test', signal, client }, (e) => events.push(e));
  return events;
}

describe('runSession', () => {
  it('streams a run as events in order', async () => {
    const { client } = fakeClient([
      message([text('Looking.'), toolUse('describe_schema', {})], 'tool_use'),
      message([toolUse('report_finding', finding)], 'tool_use'),
      message([text('1 finding.')], 'end_turn'),
    ]);

    const events = await collect('find waste', client);

    assert.deepEqual(
      events.map((e) => e.type),
      [
        'run_started', 'turn_started', 'turn_ended', 'tool_call',
        'turn_started', 'turn_ended', 'tool_call', 'finding',
        'turn_started', 'turn_ended', 'run_finished',
      ],
    );
    const found = events.find((e) => e.type === 'finding');
    assert.equal(found?.finding.title, 'Idle instance');
    const last = events.at(-1);
    assert.ok(last?.type === 'run_finished');
    assert.equal(last.summary, '1 finding.');
    assert.equal(last.stopReason, 'completed');
    assert.equal(last.turns, 3);
    assert.equal(last.toolCalls, 2);
  });

  it('uses the default question when blank', async () => {
    const { client, requests } = fakeClient([message([text('Nothing.')], 'end_turn')]);

    const events = await collect('  ', client);

    const started = events[0];
    assert.ok(started?.type === 'run_started');
    assert.equal(started.question, DEFAULT_QUESTION);
    assert.equal(requests[0]?.messages[0]?.content, DEFAULT_QUESTION);
  });

  it('does not emit a finding for a rejected report', async () => {
    const { client } = fakeClient([
      message([toolUse('report_finding', { ...finding, resource_ids: ['i-does-not-exist'] })], 'tool_use'),
      message([text('Done.')], 'end_turn'),
    ]);

    const events = await collect('find waste', client);

    const call = events.find((e) => e.type === 'tool_call');
    assert.equal(call?.type === 'tool_call' && call.call.isError, true);
    assert.equal(events.some((e) => e.type === 'finding'), false);
  });

  it('reports an abort as a finished run', async () => {
    const controller = new AbortController();
    const { client } = fakeClient([
      () => {
        controller.abort();
        return message([text('Looking.'), toolUse('describe_schema', {})], 'tool_use');
      },
    ]);

    const events = await collect('find waste', client, controller.signal);

    const last = events.at(-1);
    assert.ok(last?.type === 'run_finished');
    assert.equal(last.stopReason, 'aborted');
  });

  it('never throws, stops emitting and aborts the agent when the consumer throws', async () => {
    const { client, requests } = fakeClient([
      message([toolUse('describe_schema', {})], 'tool_use'),
      message([text('Hi.')], 'end_turn'),
    ]);
    const seen: string[] = [];
    await runSession('q', { db, model: 'claude-test', signal: new AbortController().signal, client }, (e) => {
      seen.push(e.type);
      if (e.type === 'turn_started') throw new Error('stream closed');
    });
    assert.deepEqual(seen, ['run_started', 'turn_started']);
    assert.equal(requests.length, 1);
  });

  it('still starts the run, with zero spend, when the spend query fails', async () => {
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'query') {
          return (sql: string, ...rest: unknown[]) =>
            /SUM\(EffectiveCost\)/.test(sql) && /MAX\(ChargePeriodStart\)/.test(sql)
              ? Promise.resolve({ ok: false, error: 'boom' })
              : (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const { client } = fakeClient([message([text('Done.')], 'end_turn')]);
    const events: RunEvent[] = [];
    await runSession('q', { db: failing, model: 'claude-test', signal: new AbortController().signal, client }, (e) =>
      events.push(e),
    );
    const first = events[0];
    assert.ok(first?.type === 'run_started');
    assert.equal(first.monthlySpendUsd, 0);
    assert.equal(events.at(-1)?.type, 'run_finished');
  });

  it('ends with a single run_failed when the agent throws', async () => {
    const { client } = fakeClient([
      () => {
        throw new Error('kaboom');
      },
    ]);
    const events = await collect('q', client);
    const terminals = events.filter((e) => e.type === 'run_finished' || e.type === 'run_failed');
    assert.equal(terminals.length, 1);
    const last = events.at(-1);
    assert.ok(last?.type === 'run_failed');
    assert.equal(last.error, 'kaboom');
  });
});

describe('monthlySpend', () => {
  it('computes monthly spend over the last 30 days', async () => {
    const res = await db.query(
      `SELECT CAST(ChargePeriodStart AS DATE)::VARCHAR AS day, SUM(EffectiveCost) AS cost
       FROM billing GROUP BY 1 ORDER BY 1`,
      { maxRows: 10_000, timeoutMs: 10_000, maxChars: 10_000_000 },
    );
    assert.ok(res.ok);
    const days = res.rows.map((r) => Number(r.cost));
    const expected = days.slice(-30).reduce((a, b) => a + b, 0);
    const total = days.reduce((a, b) => a + b, 0);

    const spend = await monthlySpend(db);

    assert.ok(Math.abs(spend - expected) < 0.01, `${spend} vs ${expected}`);
    assert.ok(spend > 0);
    assert.ok(days.length > 30 && spend < total);
  });
});
