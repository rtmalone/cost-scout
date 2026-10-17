/**
 * Builds the synthetic dataset from scenario.ts:
 *
 *   data/cost-scout.duckdb      the database the agent queries (opened read-only)
 *   data/parquet/*.parquet      the same tables as portable Parquet files
 *   evals/ground-truth.json     the answer key the evals score against
 *
 * Deterministic: a fixed seed means the same data on every run, so eval
 * scores are comparable across prompt and model changes.
 *
 * Usage: pnpm generate
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERIOD_DAYS, PERIOD_START, RESOURCES, buildGroundTruth, type ResourceSpec, type Rng } from './scenario.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_DATA_DIR = join(ROOT, 'data');
export const DEFAULT_GROUND_TRUTH_PATH = join(ROOT, 'evals', 'ground-truth.json');
export const DB_FILENAME = 'cost-scout.duckdb';
const SEED = 3116;

/** Small seeded PRNG (mulberry32): deterministic and good enough for synthetic noise. */
function mulberry32(seed: number): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));

function billingRow(r: ResourceSpec, date: string, usage: number) {
  const cost = round(usage * r.unitPrice, 6);
  return {
    BillingAccountId: r.account.billingAccountId,
    SubAccountId: r.account.id,
    SubAccountName: r.account.name,
    ServiceProviderName: r.provider,
    HostProviderName: r.provider,
    ServiceName: r.serviceName,
    ServiceCategory: r.serviceCategory,
    RegionId: r.region,
    ResourceId: r.id,
    ResourceName: r.name,
    ResourceType: r.resourceType,
    SkuId: r.skuId,
    ChargeCategory: 'Usage',
    ChargeDescription: r.chargeDescription,
    ChargePeriodStart: `${date} 00:00:00`,
    ChargePeriodEnd: `${addDays(date, 1)} 00:00:00`,
    ConsumedQuantity: round(usage, 6),
    ConsumedUnit: r.usageUnit,
    ListUnitPrice: r.unitPrice,
    ListCost: cost,
    BilledCost: cost,
    EffectiveCost: cost,
    BillingCurrency: 'USD',
    Tags: JSON.stringify(r.tags),
  };
}

function toNdjson(rows: object[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

export async function generate(opts: { dataDir?: string; groundTruthPath?: string } = {}) {
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  const groundTruthPath = opts.groundTruthPath ?? DEFAULT_GROUND_TRUTH_PATH;
  const dbPath = join(dataDir, DB_FILENAME);
  const parquetDir = join(dataDir, 'parquet');

  const rng = mulberry32(SEED);
  const billing: object[] = [];
  const metrics: object[] = [];

  for (let day = 0; day < PERIOD_DAYS; day++) {
    const date = addDays(PERIOD_START, day);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekday = dow >= 1 && dow <= 5;
    for (const r of RESOURCES) {
      if (date < r.createdAt) continue;
      const { usage, metrics: dayMetrics } = r.sample({ day, date, weekday, rng });
      if (usage > 0) billing.push(billingRow(r, date, usage));
      for (const [metric_name, value, unit] of dayMetrics ?? []) {
        metrics.push({ metric_date: date, resource_id: r.id, metric_name, value: round(value, 3), unit });
      }
    }
  }

  const resources = RESOURCES.map((r) => ({
    resource_id: r.id,
    resource_name: r.name,
    provider: r.provider,
    account_id: r.account.id,
    account_name: r.account.name,
    region: r.region,
    service_name: r.serviceName,
    resource_type: r.resourceType,
    created_at: r.createdAt,
    attributes: JSON.stringify(r.attributes),
    tags: JSON.stringify(r.tags),
  }));

  // Stage as NDJSON, then let DuckDB load with explicit column types.
  const staging = mkdtempSync(join(tmpdir(), 'cost-scout-'));
  const stage = (name: string, rows: object[]) => {
    const path = join(staging, `${name}.ndjson`);
    writeFileSync(path, toNdjson(rows));
    return path;
  };

  mkdirSync(parquetDir, { recursive: true });
  rmSync(dbPath, { force: true });

  const instance = await DuckDBInstance.create(dbPath);
  const conn = await instance.connect();
  try {
    await conn.run(`
      CREATE TABLE billing AS
      SELECT * REPLACE (Tags::JSON AS Tags)
      FROM read_json('${stage('billing', billing)}', format = 'newline_delimited', columns = {
        BillingAccountId: 'VARCHAR', SubAccountId: 'VARCHAR', SubAccountName: 'VARCHAR',
        ServiceProviderName: 'VARCHAR', HostProviderName: 'VARCHAR', ServiceName: 'VARCHAR', ServiceCategory: 'VARCHAR',
        RegionId: 'VARCHAR', ResourceId: 'VARCHAR', ResourceName: 'VARCHAR', ResourceType: 'VARCHAR',
        SkuId: 'VARCHAR', ChargeCategory: 'VARCHAR', ChargeDescription: 'VARCHAR',
        ChargePeriodStart: 'TIMESTAMP', ChargePeriodEnd: 'TIMESTAMP',
        ConsumedQuantity: 'DOUBLE', ConsumedUnit: 'VARCHAR', ListUnitPrice: 'DOUBLE',
        ListCost: 'DOUBLE', BilledCost: 'DOUBLE', EffectiveCost: 'DOUBLE',
        BillingCurrency: 'VARCHAR', Tags: 'VARCHAR'
      })`);

    await conn.run(`
      CREATE TABLE resources AS
      SELECT * REPLACE (attributes::JSON AS attributes, tags::JSON AS tags)
      FROM read_json('${stage('resources', resources)}', format = 'newline_delimited', columns = {
        resource_id: 'VARCHAR', resource_name: 'VARCHAR', provider: 'VARCHAR',
        account_id: 'VARCHAR', account_name: 'VARCHAR', region: 'VARCHAR',
        service_name: 'VARCHAR', resource_type: 'VARCHAR', created_at: 'DATE',
        attributes: 'VARCHAR', tags: 'VARCHAR'
      })`);

    await conn.run(`
      CREATE TABLE resource_metrics AS
      SELECT * FROM read_json('${stage('metrics', metrics)}', format = 'newline_delimited', columns = {
        metric_date: 'DATE', resource_id: 'VARCHAR', metric_name: 'VARCHAR', value: 'DOUBLE', unit: 'VARCHAR'
      })`);

    for (const table of ['billing', 'resources', 'resource_metrics']) {
      await conn.run(`COPY ${table} TO '${join(parquetDir, `${table}.parquet`)}' (FORMAT parquet)`);
    }
  } finally {
    conn.closeSync();
    instance.closeSync();
    rmSync(staging, { recursive: true, force: true });
  }

  const groundTruth = buildGroundTruth();
  mkdirSync(dirname(groundTruthPath), { recursive: true });
  writeFileSync(groundTruthPath, JSON.stringify(groundTruth, null, 2) + '\n');

  return { dbPath, groundTruth, counts: { billing: billing.length, resources: resources.length, metrics: metrics.length } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dbPath, groundTruth, counts } = await generate();
  const total = groundTruth.findings.reduce((sum, f) => sum + f.expected_monthly_savings_usd, 0);
  console.log(`Wrote ${dbPath}`);
  console.log(`  billing rows: ${counts.billing}, resources: ${counts.resources}, metric rows: ${counts.metrics}`);
  console.log(`  planted findings: ${groundTruth.findings.length} (~$${total.toFixed(2)}/month), decoys: ${groundTruth.decoys.length}`);
}
