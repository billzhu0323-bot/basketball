import type { PoolClient } from "pg";
import { env } from "../../config/env.js";
import { withTenant, type TenantContext } from "../../db/tenant.js";
import { AppError } from "../../lib/errors.js";
import { nextAllowedSendTime } from "../../lib/time.js";
import { consumeQuota, refundQuota } from "../billing/entitlements.js";
import { renderTemplate } from "./template.js";
import { sendSms } from "./twilio.client.js";

export interface EnqueueResult {
  reviewRequestId: string | null;
  status: "queued" | "skipped" | "duplicate" | "sent" | "failed";
  sendAfter?: Date;
  skipReason?: string;
}

/**
 * Creates the review request for a completed job (idempotent: one per job).
 * Applies consent, opt-out, dedupe, and quiet-hours policy, and records a
 * `skipped` row with the reason when policy says not to send.
 * Must run inside withTenant().
 */
export async function enqueueReviewRequest(db: PoolClient, jobId: string): Promise<EnqueueResult> {
  const { rows } = await db.query(
    `SELECT j.id AS job_id, j.status, c.id AS customer_id, c.first_name, c.phone_e164, c.sms_consent,
            c.opted_out_at, l.id AS location_id, l.title AS business_name, l.review_url,
            o.timezone, s.template, s.send_delay_minutes, s.quiet_hours_start, s.quiet_hours_end,
            s.dedupe_window_days, s.enabled
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     JOIN business_locations l ON l.id = j.location_id
     JOIN organizations o ON o.id = j.organization_id
     LEFT JOIN sms_settings s ON s.organization_id = j.organization_id
     WHERE j.id = $1`,
    [jobId],
  );
  const r = rows[0];
  if (!r) throw new Error(`job ${jobId} not visible in tenant context`);

  let skipReason: string | undefined;
  if (r.status !== "completed") skipReason = "job_not_completed";
  else if (r.enabled === false) skipReason = "sms_disabled";
  else if (!r.sms_consent) skipReason = "no_consent";
  else if (r.opted_out_at) skipReason = "opted_out";
  else if (!r.review_url) skipReason = "missing_review_url";
  else {
    const { rows: recent } = await db.query(
      `SELECT 1 FROM review_requests
       WHERE customer_id = $1 AND status IN ('queued','sending','sent','delivered')
         AND created_at > now() - make_interval(days => $2) LIMIT 1`,
      [r.customer_id, r.dedupe_window_days ?? 90],
    );
    if (recent[0]) skipReason = "recently_requested";
  }

  const earliest = new Date(Date.now() + (r.send_delay_minutes ?? 0) * 60_000);
  const sendAfter = nextAllowedSendTime(earliest, r.timezone, r.quiet_hours_start ?? 21, r.quiet_hours_end ?? 9);
  const body = renderTemplate(r.template ?? "", {
    first_name: r.first_name,
    business_name: r.business_name,
    review_url: r.review_url,
  });

  const { rows: ins } = await db.query<{ id: string }>(
    `INSERT INTO review_requests
       (organization_id, job_id, customer_id, location_id, to_phone, body, status, skip_reason, send_after)
     VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (job_id) DO NOTHING
     RETURNING id`,
    [jobId, r.customer_id, r.location_id, r.phone_e164, body, skipReason ? "skipped" : "queued", skipReason ?? null, sendAfter],
  );
  if (!ins[0]) return { reviewRequestId: null, status: "duplicate" };
  return skipReason
    ? { reviewRequestId: ins[0].id, status: "skipped", skipReason }
    : { reviewRequestId: ins[0].id, status: "queued", sendAfter };
}

/**
 * Sends one review request. `claimed` = the row was already moved to
 * 'sending' (by the worker's claim function); otherwise we claim it here.
 */
export async function dispatchReviewRequest(ctx: TenantContext, id: string, claimed = false): Promise<void> {
  const job = await withTenant(ctx, async (db) => {
    if (!claimed) {
      const { rowCount } = await db.query(
        `UPDATE review_requests SET status = 'sending', attempts = attempts + 1
         WHERE id = $1 AND status = 'queued' AND send_after <= now()`,
        [id],
      );
      if (!rowCount) return null; // already sent, skipped, or not yet due
    }
    const { rows } = await db.query<{
      id: string; to_phone: string; body: string; messaging_service_sid: string | null;
      opted_out_at: Date | null; recently_texted: boolean;
    }>(
      `SELECT r.id, r.to_phone, r.body, s.messaging_service_sid, c.opted_out_at,
              EXISTS (SELECT 1 FROM review_requests o
                      WHERE o.customer_id = r.customer_id AND o.id <> r.id
                        AND o.status IN ('sent','delivered')
                        AND o.sent_at > now() - make_interval(days => COALESCE(s.dedupe_window_days, 90))
                     ) AS recently_texted
       FROM review_requests r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN sms_settings s ON s.organization_id = r.organization_id
       WHERE r.id = $1 AND r.status = 'sending'`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    // Re-check opt-out at send time (a STOP may have arrived since enqueue).
    if (row.opted_out_at) {
      await db.query("UPDATE review_requests SET status = 'skipped', skip_reason = 'opted_out' WHERE id = $1", [id]);
      return null;
    }
    if (row.recently_texted) {
      await db.query("UPDATE review_requests SET status = 'skipped', skip_reason = 'recently_requested' WHERE id = $1", [id]);
      return null;
    }
    try {
      await consumeQuota(db, "sms");
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== "quota_exceeded") throw err;
      await db.query("UPDATE review_requests SET status = 'skipped', skip_reason = 'quota_exceeded' WHERE id = $1", [id]);
      return null;
    }
    return row;
  });
  if (!job) return;

  const service = job.messaging_service_sid ?? env.TWILIO_DEFAULT_MESSAGING_SERVICE_SID;
  try {
    if (!service) throw new Error("No Twilio Messaging Service configured");
    const res = await sendSms(job.to_phone, job.body, service);
    await withTenant(ctx, (db) =>
      db.query(
        "UPDATE review_requests SET status = 'sent', twilio_message_sid = $2, sent_at = now() WHERE id = $1",
        [id, res.sid],
      ),
    );
  } catch (err: any) {
    await withTenant(ctx, async (db) => {
      await db.query(
        "UPDATE review_requests SET status = 'failed', error_code = $2, error_message = $3 WHERE id = $1",
        [id, err?.code ? String(err.code) : null, String(err?.message ?? err).slice(0, 500)],
      );
      await refundQuota(db, "sms");
    });
  }
}

/** Mark a job complete and fire its review request right away if allowed. */
export async function completeJobAndRequestReview(ctx: TenantContext, jobId: string, completedAt?: Date) {
  const result = await withTenant(ctx, async (db) => {
    const { rowCount } = await db.query(
      `UPDATE jobs SET status = 'completed', completed_at = COALESCE($2, completed_at, now())
       WHERE id = $1 AND status <> 'canceled'`,
      [jobId, completedAt ?? null],
    );
    if (!rowCount) return null;
    return enqueueReviewRequest(db, jobId);
  });
  if (result?.status === "queued" && result.reviewRequestId && result.sendAfter! <= new Date()) {
    // "Immediately after the job": send inline. Anything deferred (delay or
    // quiet hours) or interrupted is picked up by the dispatcher worker.
    await dispatchReviewRequest(ctx, result.reviewRequestId);
    const final = await withTenant(ctx, async (db) => {
      const { rows } = await db.query("SELECT status, skip_reason FROM review_requests WHERE id = $1", [result.reviewRequestId]);
      return rows[0] as { status: EnqueueResult["status"]; skip_reason: string | null };
    });
    return { ...result, status: final.status, skipReason: final.skip_reason ?? undefined };
  }
  return result;
}
