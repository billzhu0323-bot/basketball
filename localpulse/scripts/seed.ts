/**
 * Demo data: one user, one organization ("Evergreen Decks"), one location,
 * one consenting customer, and an integration API key. Idempotent.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();

const DEMO_KEY = "lp_live_demo_key_do_not_use_in_production";

await client.query("BEGIN");
const { rows: u } = await client.query<{ id: string }>(
  "SELECT app.upsert_user('dev|owner', 'owner@evergreendecks.test', 'Olivia Owner') AS id",
);
const userId = u[0]!.id;
let { rows: o } = await client.query<{ id: string }>("SELECT id FROM organizations WHERE slug = 'evergreen-decks'");
if (!o[0]) {
  ({ rows: o } = await client.query("SELECT app.create_organization($1, 'Evergreen Decks', 'evergreen-decks') AS id", [userId]));
}
const orgId = o[0]!.id;
await client.query(
  `INSERT INTO business_locations (organization_id, title, primary_category, city, region, service_keywords, review_url)
   VALUES ($1, 'Evergreen Decks', 'Deck builder', 'Kirkland', 'WA',
           ARRAY['deck builder', 'composite deck installation', 'deck repair'],
           'https://search.google.com/local/writereview?placeid=MOCK_PLACE_ID')
   ON CONFLICT DO NOTHING`,
  [orgId],
);
await client.query(
  `INSERT INTO customers (organization_id, first_name, phone_e164, sms_consent, consent_source, consent_at)
   VALUES ($1, 'Sam', '+12065550123', true, 'invoice_checkbox', now())
   ON CONFLICT (organization_id, phone_e164) DO NOTHING`,
  [orgId],
);
await client.query(
  `INSERT INTO api_keys (organization_id, name, key_prefix, key_hash, created_by)
   VALUES ($1, 'Demo integration', $2, $3, $4) ON CONFLICT (key_hash) DO NOTHING`,
  [orgId, DEMO_KEY.slice(0, 12), createHash("sha256").update(DEMO_KEY).digest(), userId],
);
await client.query("COMMIT");
await client.end();

console.log(`seeded org ${orgId} (owner user ${userId})`);
console.log(`demo integration API key: ${DEMO_KEY}`);
console.log("mint a user token with: npm run dev:token");
