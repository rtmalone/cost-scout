import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { generate } from '../src/data/generate.ts';
import { RESOURCES, buildGroundTruth } from '../src/data/scenario.ts';
import { ReadOnlyDb } from '../src/tools/db.ts';
import { handleToolCall, type ToolContext } from '../src/tools/index.ts';
import type { Finding } from '../src/findings.ts';

let dir: string;
let db: ReadOnlyDb;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cost-scout-test-'));
  const { dbPath } = await generate({ dataDir: dir, groundTruthPath: join(dir, 'ground-truth.json') });
  db = await ReadOnlyDb.open(dbPath);
});

after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ReadOnlyDb guardrails', () => {
  it('runs a SELECT', async () => {
    const r = await db.query('SELECT count(*) AS n FROM resources');
    assert.ok(r.ok);
    assert.equal(Number(r.rows[0]?.n), RESOURCES.length);
  });

  for (const [label, sql] of [
    ['INSERT', "INSERT INTO resources (resource_id) VALUES ('x')"],
    ['DROP', 'DROP TABLE billing'],
    ['COPY to a file', "COPY billing TO '/tmp/leak.csv'"],
    ['SET', 'SET enable_external_access = true'],
    ['ATTACH', "ATTACH '/tmp/other.duckdb'"],
  ] as const) {
    it(`rejects ${label}`, async () => {
      const r = await db.query(sql);
      assert.equal(r.ok, false);
    });
  }

  it('rejects multiple statements', async () => {
    const r = await db.query('SELECT 1; DROP TABLE billing');
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : '', /exactly one statement/);
  });

  it('blocks reading local files from inside a SELECT', async () => {
    const r = await db.query("SELECT * FROM read_csv('/etc/hosts')");
    assert.equal(r.ok, false);
  });

  it('caps rows and reports truncation', async () => {
    const r = await db.query('SELECT * FROM range(1000)');
    assert.ok(r.ok);
    assert.equal(r.rowCount, 200);
    assert.equal(r.truncated, true);
  });

  it('cancels long-running queries', async () => {
    const r = await db.query('SELECT sum(a.range * b.range) FROM range(200000) a, range(200000) b', {
      maxRows: 10,
      timeoutMs: 300,
      maxChars: 1000,
    });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : '', /cancelled/);
  });

  it('cancels only the query that timed out when queries run in parallel', { timeout: 15_000 }, async () => {
    // The quick query starts first and is still running when the long query's 200 ms timer fires.
    // With a shared connection that interrupt hit the quick query, and the long one ran to the end.
    const timed = async (sql: string, timeoutMs: number) => {
      const started = performance.now();
      const result = await db.query(sql, { maxRows: 10, timeoutMs, maxChars: 1000 });
      return { result, ms: performance.now() - started };
    };
    const [quick, long] = await Promise.all([
      timed('SELECT sum(a.range * b.range) AS s FROM range(30000) a, range(30000) b', 60_000),
      timed('SELECT sum(a.range * b.range) AS s FROM range(100000) a, range(100000) b', 200),
    ]);

    assert.ok(quick.ms > 200, `the quick query must outlast the other's timeout to test anything (took ${Math.round(quick.ms)} ms)`);
    assert.equal(quick.result.ok, true, !quick.result.ok ? quick.result.error : '');
    assert.equal(long.result.ok, false, 'the long query should have been cancelled');
    assert.match(!long.result.ok ? long.result.error : '', /200 ms and was cancelled/);
    assert.ok(long.ms < 3000, `cancelled within 3 s (took ${Math.round(long.ms)} ms)`);
  });
});

describe('report_finding', () => {
  const valid = {
    title: 'Idle instance',
    category: 'compute',
    resource_ids: ['i-0e8f7a6b5c4d30031'],
    evidence: 'CPU averaged 1.2% over 90 days',
    estimated_monthly_savings_usd: 276.48,
    proposed_change: 'aws ec2 stop-instances --instance-ids i-0e8f7a6b5c4d30031',
    rollback: 'aws ec2 start-instances --instance-ids i-0e8f7a6b5c4d30031',
    risk: 'low',
    approval_notes: 'Confirm with data@acme.example',
  };

  const ctx = (): ToolContext => ({ db, findings: [] as Finding[] });

  it('records a valid finding', async () => {
    const c = ctx();
    const out = await handleToolCall('report_finding', valid, c);
    assert.equal(out.isError, false);
    assert.equal(c.findings.length, 1);
  });

  it('rejects a hallucinated resource id', async () => {
    const c = ctx();
    const out = await handleToolCall('report_finding', { ...valid, resource_ids: ['i-doesnotexist'] }, c);
    assert.equal(out.isError, true);
    assert.match(out.content, /unknown resource_ids/);
    assert.equal(c.findings.length, 0);
  });

  it('rejects missing rollback and a bad category', async () => {
    const out = await handleToolCall('report_finding', { ...valid, rollback: '', category: 'vibes' }, ctx());
    assert.equal(out.isError, true);
    assert.match(out.content, /rollback is required/);
    assert.match(out.content, /category must be one of/);
  });
});

describe('ground truth', () => {
  it('references only resources that exist in the data', async () => {
    const gt = buildGroundTruth();
    const ids = [...gt.findings.flatMap((f) => f.resource_ids), ...gt.decoys.map((d) => d.resource_id)];
    const known = await db.knownResourceIds(ids);
    assert.deepEqual(ids.filter((id) => !known.has(id)), []);
  });

  it('never marks a resource as both waste and decoy', () => {
    assert.deepEqual(RESOURCES.filter((r) => r.waste && r.decoy).map((r) => r.id), []);
  });
});
