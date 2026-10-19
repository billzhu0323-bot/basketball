import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../../db/pool.js";
import { withTenant, withUser } from "../../db/tenant.js";
import { requireTenant, requireUser, tenantOf } from "../../plugins/auth.js";
import { generateApiKey } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { assertBelowLimit } from "../billing/entitlements.js";

const CreateOrg = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
});

export async function organizationRoutes(app: FastifyInstance) {
  // Orgs the caller belongs to (for an org switcher).
  // Orgs the caller belongs to (for an org switcher).
  app.get("/v1/me/organizations", { preHandler: requireUser }, async (req) =>
    withUser(req.userId!, async (db) => {
      const { rows } = await db.query("SELECT * FROM app.my_organizations()");
      return { organizations: rows };
    }),
  );

  app.post("/v1/organizations", { preHandler: requireUser }, async (req, reply) => {
    const body = CreateOrg.parse(req.body);
    try {
      const { rows } = await pool.query<{ id: string }>("SELECT app.create_organization($1, $2, $3) AS id", [
        req.userId,
        body.name,
        body.slug,
      ]);
      return reply.code(201).send({ id: rows[0]!.id, ...body, plan_id: "free" });
    } catch (err: any) {
      if (err.code === "23505") throw new AppError(409, "slug_taken", "Slug already in use");
      throw err;
    }
  });

  app.post("/v1/organizations/members", { preHandler: requireTenant("admin") }, async (req, reply) => {
    const body = z.object({ user_id: z.uuid(), role: z.enum(["admin", "member"]) }).parse(req.body);
    // Production: send an invite email and create the membership on accept.
    return withTenant(tenantOf(req), async (db) => {
      const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships");
      await assertBelowLimit(db, "seats", rows[0]!.n);
      await db.query(
        "INSERT INTO memberships (organization_id, user_id, role) VALUES (app.current_org_id(), $1, $2)",
        [body.user_id, body.role],
      );
      return reply.code(201).send({ ok: true });
    });
  });

  // Returns the plaintext key exactly once.
  app.post("/v1/api-keys", { preHandler: requireTenant("admin") }, async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(60) }).parse(req.body);
    const t = tenantOf(req);
    const k = generateApiKey();
    await withTenant(t, (db) =>
      db.query(
        `INSERT INTO api_keys (organization_id, name, key_prefix, key_hash, created_by)
         VALUES (app.current_org_id(), $1, $2, $3, $4)`,
        [name, k.prefix, k.hash, t.userId],
      ),
    );
    return reply.code(201).send({ name, key: k.key, prefix: k.prefix });
  });
}
