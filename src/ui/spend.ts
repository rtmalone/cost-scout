import type { ReadOnlyDb } from '../tools/db.ts';

/** Sum of EffectiveCost over the 30 days ending at the latest ChargePeriodStart in the billing data. */
export async function monthlySpend(db: ReadOnlyDb): Promise<number> {
  const result = await db.query(`
    SELECT COALESCE(SUM(EffectiveCost), 0) AS total
    FROM billing
    WHERE CAST(ChargePeriodStart AS DATE) > (SELECT CAST(MAX(ChargePeriodStart) AS DATE) FROM billing) - INTERVAL 30 DAY`);
  if (!result.ok) throw new Error(`monthly spend query failed: ${result.error}`);
  return Number(result.rows[0]?.total ?? 0);
}
