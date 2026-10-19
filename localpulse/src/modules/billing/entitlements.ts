import type { PoolClient } from "pg";
import { AppError } from "../../lib/errors.js";

export type Metric = "photo_posts" | "sms";
export type LimitKey = Metric | "locations" | "seats";

export interface Entitlements {
  planId: string;
  limits: Partial<Record<LimitKey, number | null>>;
}

/**
 * Effective plan for the current tenant. A lapsed subscription (past_due
 * beyond grace, canceled, incomplete) drops the org to the free tier's limits.
 */
export async function getEntitlements(db: PoolClient): Promise<Entitlements> {
  const { rows } = await db.query<{ plan_id: string; limits: Entitlements["limits"] }>(`
    SELECT p.id AS plan_id, p.limits
    FROM organizations o
    LEFT JOIN subscriptions s ON s.organization_id = o.id
    JOIN plans p ON p.id = CASE
      WHEN o.plan_id = 'free' THEN 'free'
      WHEN s.status IN ('active', 'trialing') THEN o.plan_id
      WHEN s.status = 'past_due' AND s.current_period_end > now() - interval '7 days' THEN o.plan_id
      ELSE 'free'
    END
    WHERE o.id = app.current_org_id()`);
  const row = rows[0];
  if (!row) throw new AppError(404, "not_found", "Organization not found");
  return { planId: row.plan_id, limits: row.limits };
}

/**
 * Atomically consume one unit of a monthly metered limit. The conditional
 * upsert means two concurrent requests can't both squeeze past the cap.
 */
export async function consumeQuota(db: PoolClient, metric: Metric, amount = 1): Promise<void> {
  const { limits, planId } = await getEntitlements(db);
  const limit = limits[metric];
  const cap = limit === null || limit === undefined ? 2_147_483_647 : limit;
  const { rowCount } = await db.query(
    `INSERT INTO usage_counters (organization_id, metric, period_start, count)
     SELECT app.current_org_id(), $1::text, date_trunc('month', now())::date, $2::int
     WHERE $2::int <= $3::int
     ON CONFLICT (organization_id, metric, period_start)
     DO UPDATE SET count = usage_counters.count + EXCLUDED.count
     WHERE usage_counters.count + EXCLUDED.count <= $3::int`,
    [metric, amount, cap],
  );
  if (rowCount === 0) {
    throw new AppError(402, "quota_exceeded", `Monthly ${metric} limit reached on the ${planId} plan`);
  }
}

/** Refund a unit when the downstream action definitively failed. */
export async function refundQuota(db: PoolClient, metric: Metric, amount = 1): Promise<void> {
  await db.query(
    `UPDATE usage_counters SET count = greatest(count - $2::int, 0)
     WHERE organization_id = app.current_org_id() AND metric = $1
       AND period_start = date_trunc('month', now())::date`,
    [metric, amount],
  );
}

/** For non-metered caps (locations, seats): compare a current count to the limit. */
export async function assertBelowLimit(db: PoolClient, key: "locations" | "seats", current: number) {
  const { limits, planId } = await getEntitlements(db);
  const limit = limits[key];
  if (limit !== null && limit !== undefined && current >= limit) {
    throw new AppError(402, "plan_limit", `The ${planId} plan allows ${limit} ${key}`);
  }
}
