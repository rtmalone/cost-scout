import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolCallRecord } from '../src/agent/run.ts';
import type { RunEvent } from '../src/ui/events.ts';
import type { Finding } from '../src/findings.ts';
import { axisTicks, shortenId, usd } from '../web/src/lib/format.ts';
import { callLabel } from '../web/src/lib/labels.ts';
import { initialState, reduce, statusText, type ClientEvent, type RunState } from '../web/src/lib/runState.ts';
import { readNdjson } from '../web/src/lib/stream.ts';

function call(over: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'c1',
    turn: 1,
    name: 'run_sql',
    input: {},
    isError: false,
    startedAt: '2026-10-20T10:00:00.000Z',
    durationMs: 5,
    summary: '12 rows',
    ...over,
  };
}

const finding: Finding = {
  title: 'Idle NAT gateway',
  category: 'network',
  resource_ids: ['nat-1'],
  evidence: 'No traffic for 90 days.',
  estimated_monthly_savings_usd: 276.48,
  proposed_change: 'Delete it.',
  rollback: 'Recreate it.',
  risk: 'low',
  approval_notes: 'Network team.',
};

const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };

const started: RunEvent = {
  type: 'run_started',
  question: 'q',
  model: 'm',
  startedAt: '2026-10-20T10:00:00.000Z',
  monthlySpendUsd: 1500,
};

function apply(events: (RunEvent | ClientEvent)[], from: RunState = initialState): RunState {
  return events.reduce(reduce, from);
}

describe('format', () => {
  it('usd rounds to whole dollars with separators', () => {
    assert.equal(usd(1255.5), '$1,256');
    assert.equal(usd(40), '$40');
  });

  it('shortenId keeps both ends of a long id', () => {
    const s = shortenId('arn:aws:lambda:us-east-1:111111111111:function:etl-transform');
    assert.ok(s.length <= 22);
    assert.ok(s.includes('…'));
    assert.ok(s.startsWith('arn:aws'));
    assert.ok(s.endsWith('transform'));
    assert.equal(shortenId('i-0e8f7a6b5c4d30031'), 'i-0e8f7a6b5c4d30031');
  });

  it('axisTicks picks the smallest step giving at most 7 ticks', () => {
    assert.deepEqual(axisTicks(41_000), [0, 10, 20, 30, 40]);
    assert.deepEqual(axisTicks(240_000), [0, 60, 120, 180, 240]);
    assert.deepEqual(axisTicks(10_000), [0, 5, 10]);
  });
});

describe('callLabel', () => {
  it('uses the purpose for run_sql', () => {
    assert.deepEqual(callLabel(call({ input: { sql: 'select 1', purpose: 'Total by service' } })), {
      kind: 'query',
      label: 'Total by service',
      result: '12 rows',
    });
  });

  it('falls back to collapsed, cut SQL without a purpose', () => {
    const sql = `SELECT   a,\n  b FROM   some_table WHERE ${'x = 1 AND '.repeat(10)}y = 2`;
    const { label } = callLabel(call({ input: { sql } }));
    assert.equal(label.length, 61);
    assert.ok(label.endsWith('…'));
    assert.ok(label.startsWith('SELECT a, b FROM some_table WHERE'));
  });

  it('reads the schema with a table count', () => {
    assert.deepEqual(callLabel(call({ name: 'describe_schema', summary: '3 tables described' })), {
      kind: 'query',
      label: 'Read the schema',
      result: '3 tables',
    });
  });

  it('labels a reported finding with its savings', () => {
    assert.deepEqual(
      callLabel(
        call({
          name: 'report_finding',
          input: { title: 'Idle NAT gateway', estimated_monthly_savings_usd: 276.48 },
          summary: 'recorded',
        }),
      ),
      { kind: 'finding', label: 'Reported: Idle NAT gateway', result: '$276/mo' },
    );
  });

  it('marks a rejected finding as an error', () => {
    const r = callLabel(
      call({ name: 'report_finding', input: { title: 'Bad' }, isError: true, summary: 'Unknown resource id' }),
    );
    assert.equal(r.kind, 'error');
    assert.ok(r.label.startsWith('Finding rejected:'));
    assert.equal(r.result, 'Unknown resource id');
  });

  it('marks a failed query as an error', () => {
    const r = callLabel(call({ input: { purpose: 'Look' }, isError: true, summary: 'syntax error' }));
    assert.deepEqual(r, { kind: 'error', label: 'Look', result: 'syntax error' });
  });
});

describe('reduce', () => {
  it('builds turns, calls, findings and savings, then finishes', () => {
    const s = apply([
      { type: 'client_started', question: 'q' },
      started,
      { type: 'turn_started', turn: 1, startedAt: '2026-10-20T10:00:00.000Z' },
      { type: 'turn_ended', turn: 1, durationMs: 3000, text: 'Looking around.' },
      { type: 'tool_call', call: call({ id: 'a', turn: 1, input: { purpose: 'Spend by service', sql: 'select 1' } }) },
      { type: 'turn_started', turn: 2, startedAt: '2026-10-20T10:00:04.000Z' },
      { type: 'turn_ended', turn: 2, durationMs: 2000, text: 'All done.' },
      {
        type: 'tool_call',
        call: call({
          id: 'b',
          turn: 2,
          name: 'report_finding',
          input: { title: finding.title, estimated_monthly_savings_usd: 276.48 },
          summary: 'recorded',
        }),
      },
      { type: 'finding', toolCallId: 'b', finding },
      { type: 'turn_started', turn: 3, startedAt: '2026-10-20T10:00:07.000Z' },
      { type: 'turn_ended', turn: 3, durationMs: 1000, text: 'All done.' },
      { type: 'run_finished', stopReason: 'completed', summary: 'All done.', turns: 3, toolCalls: 2, usage },
    ]);
    assert.equal(s.phase, 'finished');
    assert.equal(s.question, 'q');
    assert.equal(s.monthlySpendUsd, 1500);
    assert.equal(s.turns.length, 3);
    assert.equal(s.turns[1]!.startMs, 4000);
    assert.equal(s.turns[0]!.durationMs, 3000);
    assert.equal(s.turns[0]!.text, 'Looking around.');
    assert.equal(s.turns[0]!.calls[0]!.sql, 'select 1');
    assert.equal(s.turns[0]!.calls[0]!.label, 'Spend by service');
    assert.equal(s.turns[1]!.calls[0]!.kind, 'finding');
    assert.equal(s.findings.length, 1);
    assert.equal(s.savingsUsd, 276.48);
    // The summary shows in the results pane, so the last turn's text is cleared.
    assert.equal(s.turns[2]!.text, '');
    assert.equal(s.turns[1]!.text, 'All done.');
    assert.equal(s.end?.summary, 'All done.');
  });

  it('closes an open turn when the run is aborted, keeping findings', () => {
    const s = apply([
      started,
      { type: 'turn_started', turn: 1, startedAt: '2026-10-20T10:00:00.000Z' },
      { type: 'turn_ended', turn: 1, durationMs: 1000, text: '' },
      { type: 'tool_call', call: call({ id: 'b', name: 'report_finding', input: { title: 'T', estimated_monthly_savings_usd: 10 } }) },
      { type: 'finding', toolCallId: 'b', finding },
      { type: 'turn_started', turn: 2, startedAt: '2026-10-20T10:00:02.000Z' },
      { type: 'run_finished', stopReason: 'aborted', stopDetail: 'Stopped by you', summary: '', turns: 2, toolCalls: 1, usage },
    ]);
    assert.equal(s.phase, 'finished');
    assert.equal(typeof s.turns[1]!.durationMs, 'number');
    assert.ok(s.turns[1]!.durationMs! >= 0);
    assert.equal(s.findings.length, 1);
    assert.equal(statusText(s, null), 'Stopped by you · 1 finding so far');
  });

  it('records failures and resets on a new client start', () => {
    const failed = apply([started, { type: 'run_failed', error: 'boom' }]);
    assert.equal(failed.phase, 'finished');
    assert.equal(statusText(failed, null), 'Something went wrong: boom');
    assert.equal(apply([{ type: 'client_error', error: 'offline' }]).error, 'offline');
    const again = reduce(failed, { type: 'client_started', question: 'next' });
    assert.deepEqual(again, { ...initialState, phase: 'running', question: 'next' });
  });
});

describe('statusText', () => {
  it('shows the first problem when not ready', () => {
    const problem = 'No dataset found. Run pnpm generate first.';
    assert.equal(statusText(initialState, { ready: false, problems: [problem], model: 'm', busy: false }), problem);
  });

  it('describes idle and running states', () => {
    const ready = { ready: true, problems: [], model: 'm', busy: false };
    assert.equal(statusText(initialState, ready), 'Ready when you are');
    let s = apply([{ type: 'client_started', question: 'q' }, started, { type: 'turn_started', turn: 1, startedAt: started.startedAt }]);
    assert.equal(statusText(s, ready), 'Reading the question');
    s = apply([{ type: 'turn_ended', turn: 1, durationMs: 10, text: '' }], s);
    assert.equal(statusText(s, ready), 'Running queries');
    s = apply([{ type: 'turn_started', turn: 2, startedAt: started.startedAt }], s);
    assert.equal(statusText(s, ready), 'Thinking about what to check next');
  });

  it('describes early stops and completion', () => {
    const end = (stopReason: 'completed' | 'max_turns', stopDetail?: string) =>
      apply([started, { type: 'run_finished', stopReason, ...(stopDetail && { stopDetail }), summary: '', turns: 0, toolCalls: 0, usage }]);
    assert.equal(statusText(end('completed'), null), 'Finished · 0 findings');
    assert.equal(statusText(end('max_turns', 'Hit the 25-turn limit'), null), 'Stopped early: Hit the 25-turn limit · 0 findings so far');
  });
});

describe('readNdjson', () => {
  it('reassembles a line split across chunks and handles a missing final newline', async () => {
    const enc = new TextEncoder();
    const a = JSON.stringify({ type: 'turn_started', turn: 1, startedAt: 'x' });
    const b = JSON.stringify({ type: 'run_failed', error: 'e' });
    const text = `${a}\n${b}`;
    const cut = a.length + 1 + 8;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(text.slice(0, cut)));
        c.enqueue(enc.encode(text.slice(cut)));
        c.close();
      },
    });
    const got: RunEvent[] = [];
    await readNdjson(body, (e) => got.push(e));
    assert.deepEqual(got, [JSON.parse(a), JSON.parse(b)]);
  });
});

describe('robustness', () => {
  it('readNdjson keeps multi-byte characters split across byte chunks intact', async () => {
    const bytes = new TextEncoder().encode(`${JSON.stringify({ type: 'run_failed', error: 'cost €5 😀' })}\n`);
    const cut = bytes.indexOf(0xe2) + 1; // one byte into the 3-byte €
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut, cut + 5)); // also splits the 4-byte emoji later
        c.enqueue(bytes.slice(cut + 5));
        c.close();
      },
    });
    const got: RunEvent[] = [];
    await readNdjson(body, (e) => got.push(e));
    assert.deepEqual(got, [{ type: 'run_failed', error: 'cost €5 😀' }]);
  });

  it('readNdjson cancels the stream and rethrows when a handler throws', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"type":"run_failed","error":"e"}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      readNdjson(body, () => {
        throw new Error('handler');
      }),
      /handler/,
    );
    assert.ok(cancelled);
  });

  it('client_error closes open turns', () => {
    const s = apply([
      started,
      { type: 'turn_started', turn: 1, startedAt: started.startedAt },
      { type: 'client_error', error: 'dropped' },
    ]);
    assert.equal(s.phase, 'finished');
    assert.ok(s.turns[0]!.durationMs! >= 0);
  });

  it('reduce does not mutate its input', () => {
    const events: (RunEvent | ClientEvent)[] = [
      { type: 'client_started', question: 'q' },
      started,
      { type: 'turn_started', turn: 1, startedAt: started.startedAt },
      { type: 'turn_ended', turn: 1, durationMs: 5, text: 'done' },
      { type: 'tool_call', call: call({ id: 'a', turn: 1 }) },
      { type: 'finding', toolCallId: 'a', finding },
      { type: 'turn_started', turn: 2, startedAt: started.startedAt },
      { type: 'turn_ended', turn: 2, durationMs: 5, text: 'sum' },
      { type: 'run_finished', stopReason: 'completed', summary: 'sum', turns: 2, toolCalls: 1, usage },
    ];
    const freeze = <T,>(o: T): T => {
      if (o && typeof o === 'object') Object.values(o).forEach(freeze);
      return Object.freeze(o);
    };
    // Frozen states throw on any in-place write (modules are strict).
    let s = initialState;
    for (const e of events) s = freeze(reduce(s, e));
    assert.equal(s.phase, 'finished');
    assert.equal(s.turns[1]!.text, '');
    assert.equal(s.turns[0]!.calls.length, 1);
  });

  it('callLabel falls back for missing fields', () => {
    assert.equal(callLabel(call({ input: {} })).label, 'Query');
    assert.equal(callLabel(call({ name: 'report_finding', input: {} })).label, 'Reported: untitled finding');
    assert.equal(
      callLabel(call({ name: 'report_finding', input: {}, isError: true })).label,
      'Finding rejected: untitled finding',
    );
  });
});
