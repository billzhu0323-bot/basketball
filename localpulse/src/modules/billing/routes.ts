import type { FastifyInstance } from "fastify";
import { requireTenant, tenantOf } from "../../plugins/auth.js";
import { withTenant } from "../../db/tenant.js";
import { getEntitlements } from "./entitlements.js";

export async function billingRoutes(app: FastifyInstance) {
  app.get("/v1/plans", async () => {
    // Public catalog; plans has no RLS.
    const { pool } = await import("../../db/pool.js");
    const { rows } = await pool.query(
      "SELECT id, name, monthly_price_cents, limits FROM plans WHERE is_public ORDER BY monthly_price_cents",
    );
    return { plans: rows };
  });

  app.get("/v1/billing/usage", { preHandler: requireTenant() }, async (req) =>
    withTenant(tenantOf(req), async (db) => {
      const ent = await getEntitlements(db);
      const { rows } = await db.query(
        `SELECT metric, count FROM usage_counters
         WHERE period_start = date_trunc('month', now())::date`,
      );
      return { plan: ent.planId, limits: ent.limits, usage: Object.fromEntries(rows.map((r) => [r.metric, r.count])) };
    }),
  );

  // TODO(billing): POST /webhooks/stripe — verify the Stripe-Signature header
  // with stripe.webhooks.constructEvent(), then on customer.subscription.*
  // upsert `subscriptions` and set organizations.plan_id from the price id.
  // Run it as the owner role or via a SECURITY DEFINER function, since the
  // event arrives without tenant context.
}
