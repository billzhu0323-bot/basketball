import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenant } from "../../db/tenant.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { toE164 } from "../../lib/phone.js";
import { requireApiKey, requireTenant, tenantOf } from "../../plugins/auth.js";
import { completeJobAndRequestReview } from "../sms/review-request.service.js";
import { validateTemplate } from "../sms/template.js";

const CustomerInput = z.object({
  first_name: z.string().max(80).optional(),
  last_name: z.string().max(80).optional(),
  phone: z.string(),
  email: z.email().optional(),
  sms_consent: z.boolean(),
  consent_source: z.string().max(60).optional(),
});

const JobInput = z.object({
  location_id: z.uuid(),
  external_ref: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  customer: CustomerInput,
});

async function upsertCustomer(db: PoolClient, c: z.infer<typeof CustomerInput>): Promise<string> {
  const phone = toE164(c.phone);
  if (!phone) throw badRequest(`Invalid phone number: ${c.phone}`);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO customers (organization_id, first_name, last_name, phone_e164, email, sms_consent, consent_source, consent_at)
     VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, CASE WHEN $5 THEN now() END)
     ON CONFLICT (organization_id, phone_e164) DO UPDATE SET
       first_name = COALESCE(EXCLUDED.first_name, customers.first_name),
       last_name  = COALESCE(EXCLUDED.last_name, customers.last_name),
       email      = COALESCE(EXCLUDED.email, customers.email),
       -- consent is only ever granted here, never silently revoked; STOP revokes.
       sms_consent    = customers.sms_consent OR EXCLUDED.sms_consent,
       consent_source = CASE WHEN EXCLUDED.sms_consent AND NOT customers.sms_consent
                             THEN EXCLUDED.consent_source ELSE customers.consent_source END,
       consent_at     = CASE WHEN EXCLUDED.sms_consent AND NOT customers.sms_consent
                             THEN now() ELSE customers.consent_at END
     RETURNING id`,
    [c.first_name ?? null, c.last_name ?? null, phone, c.email ?? null, c.sms_consent, c.consent_source ?? null],
  );
  return rows[0]!.id;
}

async function upsertJob(db: PoolClient, input: z.infer<typeof JobInput>): Promise<string> {
  const { rows: loc } = await db.query("SELECT 1 FROM business_locations WHERE id = $1", [input.location_id]);
  if (!loc[0]) throw notFound("Location");
  const customerId = await upsertCustomer(db, input.customer);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO jobs (organization_id, location_id, customer_id, external_ref, description)
     VALUES (app.current_org_id(), $1, $2, $3, $4)
     ON CONFLICT (organization_id, external_ref) DO UPDATE SET description = COALESCE(EXCLUDED.description, jobs.description)
     RETURNING id`,
    [input.location_id, customerId, input.external_ref ?? null, input.description ?? null],
  );
  return rows[0]!.id;
}

export async function jobRoutes(app: FastifyInstance) {
  app.post("/v1/jobs", { preHandler: requireTenant() }, async (req, reply) => {
    const input = JobInput.parse(req.body);
    const id = await withTenant(tenantOf(req), (db) => upsertJob(db, input));
    return reply.code(201).send({ id });
  });

  // The trigger: mark complete -> review SMS goes out immediately (or is
  // scheduled for the end of quiet hours).
  app.post<{ Params: { id: string } }>("/v1/jobs/:id/complete", { preHandler: requireTenant() }, async (req) => {
    const id = z.uuid().parse(req.params.id);
    const result = await completeJobAndRequestReview(tenantOf(req), id);
    if (!result) throw notFound("Job");
    return { job_id: id, review_request: result };
  });

  // Same trigger for field-service software / Zapier, authenticated by API key.
  app.post("/v1/integrations/job-completed", { preHandler: requireApiKey }, async (req) => {
    const input = JobInput.extend({ completed_at: z.iso.datetime().optional() }).parse(req.body);
    const t = tenantOf(req);
    const jobId = await withTenant(t, (db) => upsertJob(db, input));
    const result = await completeJobAndRequestReview(t, jobId, input.completed_at ? new Date(input.completed_at) : undefined);
    return { job_id: jobId, review_request: result };
  });

  app.get("/v1/review-requests", { preHandler: requireTenant() }, async (req) =>
    withTenant(tenantOf(req), async (db) => {
      const { rows } = await db.query(
        `SELECT r.id, r.job_id, r.to_phone, r.status, r.skip_reason, r.send_after, r.sent_at, r.delivered_at,
                r.error_code, c.first_name
         FROM review_requests r JOIN customers c ON c.id = r.customer_id
         ORDER BY r.created_at DESC LIMIT 100`,
      );
      return { review_requests: rows };
    }),
  );

  app.put("/v1/sms/settings", { preHandler: requireTenant("admin") }, async (req) => {
    const body = z
      .object({
        messaging_service_sid: z.string().regex(/^MG[0-9a-f]{32}$/i).nullable().optional(),
        template: z.string().min(20).max(320).optional(),
        send_delay_minutes: z.number().int().min(0).max(10080).optional(),
        quiet_hours_start: z.number().int().min(0).max(23).optional(),
        quiet_hours_end: z.number().int().min(0).max(23).optional(),
        enabled: z.boolean().optional(),
      })
      .parse(req.body);
    if (body.template) {
      const problems = validateTemplate(body.template);
      if (problems.length) throw badRequest(`Template ${problems.join("; ")}`);
    }
    const keys = Object.keys(body) as (keyof typeof body)[];
    if (!keys.length) throw badRequest("Nothing to update");
    return withTenant(tenantOf(req), async (db) => {
      const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", "); // keys come from the zod schema
      const { rows } = await db.query(
        `UPDATE sms_settings SET ${sets} WHERE organization_id = app.current_org_id() RETURNING *`,
        keys.map((k) => body[k]),
      );
      return rows[0];
    });
  });
}
