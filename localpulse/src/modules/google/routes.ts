import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { withTenant } from "../../db/tenant.js";
import { encrypt } from "../../lib/crypto.js";
import { badRequest } from "../../lib/errors.js";
import { requireTenant, tenantOf } from "../../plugins/auth.js";
import { assertBelowLimit } from "../billing/entitlements.js";
import { getAccessToken, listAccounts, listLocations } from "./gbp.client.js";
import { buildConsentUrl, newOAuthClient, readState } from "./oauth.js";

export async function googleRoutes(app: FastifyInstance) {
  // Step 1: front-end calls this, then redirects the browser to `url`.
  app.get("/v1/google/oauth/start", { preHandler: requireTenant("admin") }, async (req) => {
    const t = tenantOf(req);
    return { url: buildConsentUrl(t.orgId, t.userId!) };
  });

  // Step 2: Google redirects here. No bearer token — trust comes from the
  // signed state, and membership is re-checked under RLS below.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/v1/google/oauth/callback",
    async (req, reply) => {
      const back = new URL("/settings/integrations", env.APP_BASE_URL);
      const { code, state, error } = req.query;
      if (error) return reply.redirect(`${back}?google=denied`);
      const s = state ? readState(state) : null;
      if (!code || !s) throw badRequest("Invalid or expired OAuth state");

      const client = newOAuthClient();
      const { tokens } = await client.getToken(code);
      if (!tokens.access_token || !tokens.id_token) throw badRequest("Google did not return tokens");
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: env.GOOGLE_CLIENT_ID });
      const idt = ticket.getPayload()!;
      const key = env.TOKEN_ENCRYPTION_KEY;

      await withTenant({ orgId: s.orgId, userId: s.userId }, async (db) => {
        const { rows } = await db.query(
          "SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('owner','admin')",
          [s.userId],
        );
        if (!rows[0]) throw badRequest("User is no longer an admin of this organization");
        await db.query(
          `INSERT INTO google_connections
             (organization_id, google_subject, google_email, access_token_enc, refresh_token_enc,
              token_expires_at, scopes, status, connected_by)
           VALUES (app.current_org_id(), $1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, 'active', $7)
           ON CONFLICT (organization_id, google_subject) DO UPDATE SET
             google_email = EXCLUDED.google_email,
             access_token_enc = EXCLUDED.access_token_enc,
             refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, google_connections.refresh_token_enc),
             token_expires_at = EXCLUDED.token_expires_at,
             scopes = EXCLUDED.scopes, status = 'active', last_error = NULL`,
          [
            idt.sub,
            idt.email,
            encrypt(tokens.access_token!, key),
            tokens.refresh_token ? encrypt(tokens.refresh_token, key) : null,
            tokens.expiry_date ?? Date.now() + 3_000_000,
            (tokens.scope ?? "").split(" ").filter(Boolean),
            s.userId,
          ],
        );
      });
      return reply.redirect(`${back}?google=connected`);
    },
  );

  // Step 3: import the business's GBP locations (respecting the plan's cap).
  app.post("/v1/google/locations/sync", { preHandler: requireTenant("admin") }, async (req) =>
    withTenant(tenantOf(req), async (db) => {
      const { rows: conns } = await db.query<{ id: string }>(
        "SELECT id FROM google_connections WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1",
      );
      if (!conns[0]) throw badRequest("Connect Google Business Profile first");
      const token = await getAccessToken(db, conns[0].id);

      const imported = [];
      for (const acct of await listAccounts(token)) {
        for (const loc of await listLocations(token, acct.name)) {
          const { rows: existing } = await db.query("SELECT 1 FROM business_locations WHERE gbp_location_name = $1", [loc.name]);
          if (!existing[0]) {
            const { rows: c } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM business_locations WHERE is_active");
            await assertBelowLimit(db, "locations", c[0]!.n);
          }
          const { rows } = await db.query(
            `INSERT INTO business_locations
               (organization_id, google_connection_id, gbp_account_name, gbp_location_name,
                title, primary_category, city, region, review_url)
             VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (organization_id, gbp_location_name) DO UPDATE SET
               google_connection_id = EXCLUDED.google_connection_id,
               gbp_account_name = EXCLUDED.gbp_account_name,
               title = EXCLUDED.title, primary_category = EXCLUDED.primary_category,
               city = EXCLUDED.city, region = EXCLUDED.region,
               review_url = COALESCE(EXCLUDED.review_url, business_locations.review_url)
             RETURNING id, title, city, review_url`,
            [
              conns[0].id,
              acct.name,
              loc.name,
              loc.title,
              loc.categories?.primaryCategory?.displayName ?? null,
              loc.storefrontAddress?.locality ?? null,
              loc.storefrontAddress?.administrativeArea ?? null,
              loc.metadata?.newReviewUri ?? null,
            ],
          );
          imported.push(rows[0]);
        }
      }
      return { locations: imported };
    }),
  );
}
