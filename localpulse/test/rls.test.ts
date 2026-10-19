/**
 * Integration test: proves tenant isolation is enforced by Postgres itself.
 * Requires a migrated database (npm run db:migrate) and RUN_DB_TESTS=1.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.RUN_DB_TESTS === "1";
const owner = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function asTenant<T>(orgId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query("BEGIN");
    if (orgId) await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

describe.runIf(enabled)("row-level security", () => {
  let orgA: string, orgB: string;

  beforeAll(async () => {
    const suffix = Date.now().toString(36);
    const { rows: u } = await owner.query("SELECT app.upsert_user($1, $2, 'T') AS id", [`t|${suffix}`, `${suffix}@t.test`]);
    ({ rows: [{ id: orgA }] } = await owner.query("SELECT app.create_organization($1, 'A', $2) AS id", [u[0].id, `a-${suffix}`]));
    ({ rows: [{ id: orgB }] } = await owner.query("SELECT app.create_organization($1, 'B', $2) AS id", [u[0].id, `b-${suffix}`]));
    for (const [org, phone] of [[orgA, "+12065550001"], [orgB, "+12065550002"]]) {
      await owner.query("INSERT INTO customers (organization_id, phone_e164) VALUES ($1, $2)", [org, phone]);
    }
  });

  afterAll(async () => {
    if (orgA) await owner.query("DELETE FROM organizations WHERE id = ANY($1)", [[orgA, orgB]]);
    await owner.end();
    await app.end();
  });

  it("a tenant sees only its own rows", async () => {
    const phones = await asTenant(orgA, async (c) => (await c.query("SELECT phone_e164 FROM customers")).rows);
    expect(phones).toEqual([{ phone_e164: "+12065550001" }]);
  });

  it("no tenant context means no rows (fails closed)", async () => {
    const rows = await asTenant(null, async (c) => (await c.query("SELECT * FROM customers")).rows);
    expect(rows).toHaveLength(0);
  });

  it("cannot write rows into another tenant", async () => {
    await expect(
      asTenant(orgA, (c) => c.query("INSERT INTO customers (organization_id, phone_e164) VALUES ($1, '+12065550003')", [orgB])),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update another tenant's rows", async () => {
    const res = await asTenant(orgA, (c) =>
      c.query("UPDATE customers SET first_name = 'x' WHERE organization_id = $1", [orgB]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("organizations table exposes only the current org", async () => {
    const rows = await asTenant(orgB, async (c) => (await c.query("SELECT id FROM organizations")).rows);
    expect(rows).toEqual([{ id: orgB }]);
  });
});
