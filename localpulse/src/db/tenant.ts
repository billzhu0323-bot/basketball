import type { PoolClient } from "pg";
import { pool } from "./pool.js";

export interface TenantContext {
  orgId: string;
  userId?: string | null;
}

/**
 * Run `fn` inside a transaction whose RLS context is pinned to one tenant.
 * Settings are transaction-local, so a pooled connection can't leak context
 * to the next request. Keep slow network calls (Google, Twilio, Claude)
 * OUTSIDE this callback so connections aren't held open.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  return withContext({ "app.org_id": ctx.orgId, "app.user_id": ctx.userId ?? "" }, fn);
}

/** User-only context (no org yet) — used to list a user's memberships. */
export async function withUser<T>(userId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return withContext({ "app.org_id": "", "app.user_id": userId }, fn);
}

async function withContext<T>(
  settings: Record<string, string>,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of Object.entries(settings)) {
      await client.query("SELECT set_config($1, $2, true)", [key, value]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
