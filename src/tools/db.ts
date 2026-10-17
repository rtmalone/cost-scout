/**
 * Read-only SQL access for the agent, with defense in depth:
 *
 *   1. The database file is opened with access_mode=READ_ONLY.
 *   2. External access is disabled and configuration is locked, so a query
 *      can't read local files (read_csv('/etc/passwd')) or flip settings back.
 *   3. Exactly one statement per call, and it must parse as a SELECT —
 *      checked with DuckDB's own parser, not a regex.
 *   4. Results are capped by row count and serialized size, and long-running
 *      queries are interrupted.
 *
 * Any one layer should be enough. Having all four means a prompt-injected or
 * confused agent has nothing to work with.
 */

import { DuckDBInstance, LIST, StatementType, VARCHAR, type DuckDBConnection } from '@duckdb/node-api';

export interface QueryLimits {
  maxRows: number;
  timeoutMs: number;
  maxChars: number;
}

export const DEFAULT_LIMITS: QueryLimits = { maxRows: 200, timeoutMs: 10_000, maxChars: 20_000 };

export type QueryResult =
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean }
  | { ok: false; error: string };

export class ReadOnlyDb {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async open(path: string): Promise<ReadOnlyDb> {
    const instance = await DuckDBInstance.create(path, {
      access_mode: 'READ_ONLY',
      enable_external_access: 'false',
      memory_limit: '512MB',
      threads: '2',
      lock_configuration: 'true',
    });
    return new ReadOnlyDb(instance, await instance.connect());
  }

  async query(sql: string, limits: QueryLimits = DEFAULT_LIMITS): Promise<QueryResult> {
    let statements;
    try {
      statements = await this.conn.extractStatements(sql);
    } catch (e) {
      return { ok: false, error: `SQL parse error: ${message(e)}` };
    }
    if (statements.count !== 1) {
      return { ok: false, error: `Expected exactly one statement, got ${statements.count}.` };
    }

    let prepared;
    try {
      prepared = await statements.prepare(0);
    } catch (e) {
      return { ok: false, error: message(e) };
    }
    if (prepared.statementType !== StatementType.SELECT) {
      return { ok: false, error: 'Only SELECT queries are allowed. This database is read-only.' };
    }

    const timer = setTimeout(() => this.conn.interrupt(), limits.timeoutMs);
    try {
      const reader = await prepared.runAndReadUntil(limits.maxRows + 1);
      const all = reader.getRowObjectsJson();
      const truncated = all.length > limits.maxRows || !reader.done;
      let rows = all.slice(0, limits.maxRows);

      // Keep the payload inside the model's budget even when rows are wide.
      while (rows.length > 1 && JSON.stringify(rows).length > limits.maxChars) {
        rows = rows.slice(0, Math.floor(rows.length / 2));
      }
      return {
        ok: true,
        columns: reader.columnNames(),
        rows,
        rowCount: rows.length,
        truncated: truncated || rows.length < Math.min(all.length, limits.maxRows),
      };
    } catch (e) {
      const msg = message(e);
      return {
        ok: false,
        error: /interrupt/i.test(msg) ? `Query exceeded ${limits.timeoutMs} ms and was cancelled.` : msg,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resource IDs that exist in the inventory or the bill — used to reject hallucinated IDs. */
  async knownResourceIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const prepared = await this.conn.prepare(`
      SELECT resource_id AS id FROM resources WHERE list_contains($1, resource_id)
      UNION
      SELECT DISTINCT ResourceId FROM billing WHERE list_contains($1, ResourceId)`);
    prepared.bindList(1, ids, LIST(VARCHAR));
    const reader = await prepared.runAndReadAll();
    return new Set(reader.getRowObjectsJson().map((r) => String(r.id)));
  }

  close() {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
