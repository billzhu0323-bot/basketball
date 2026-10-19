import type { FastifyInstance, FastifyRequest } from "fastify";
import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { withTenant } from "../../db/tenant.js";
import { isValidTwilioSignature } from "../sms/twilio.client.js";

type TwilioParams = Record<string, string>;

const STATUS_MAP: Record<string, string> = {
  queued: "sent", accepted: "sent", sending: "sent", sent: "sent",
  delivered: "delivered", undelivered: "undelivered", failed: "failed",
};
// Never move a row backwards (callbacks can arrive out of order).
const RANK: Record<string, number> = { sending: 0, sent: 1, undelivered: 2, failed: 2, delivered: 3 };

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

function verify(req: FastifyRequest): boolean {
  const url = `${env.PUBLIC_API_URL}${req.url}`;
  return isValidTwilioSignature(req.headers["x-twilio-signature"] as string | undefined, url, req.body as TwilioParams);
}

export async function twilioWebhookRoutes(app: FastifyInstance) {
  // Delivery receipts (statusCallback on each outbound message).
  app.post("/webhooks/twilio/status", async (req, reply) => {
    if (!verify(req)) return reply.code(403).send();
    const p = req.body as TwilioParams;
    const sid = p.MessageSid;
    if (!sid) return reply.code(400).send();

    const { rows } = await pool.query<{ org: string | null }>("SELECT app.resolve_org_for_message_sid($1) AS org", [sid]);
    const orgId = rows[0]?.org;
    if (!orgId) return reply.code(204).send(); // not ours / dry-run sid

    const next = STATUS_MAP[p.MessageStatus ?? ""];
    await withTenant({ orgId }, async (db) => {
      const { rows: rr } = await db.query<{ id: string; status: string }>(
        "SELECT id, status FROM review_requests WHERE twilio_message_sid = $1 FOR UPDATE",
        [sid],
      );
      const current = rr[0];
      await db.query(
        `INSERT INTO sms_events (organization_id, review_request_id, twilio_message_sid, event_type, payload)
         VALUES (app.current_org_id(), $1, $2, $3, $4)`,
        [current?.id ?? null, sid, `status:${p.MessageStatus}`, p],
      );
      if (current && next && (RANK[next] ?? 0) > (RANK[current.status] ?? -1)) {
        await db.query(
          `UPDATE review_requests SET status = $2::review_request_status, error_code = $3,
             delivered_at = CASE WHEN $2 = 'delivered' THEN now() ELSE delivered_at END
           WHERE id = $1`,
          [current.id, next, p.ErrorCode ?? null],
        );
      }
    });
    return reply.code(204).send();
  });

  // Inbound messages: record STOP / START so we never text an opted-out number.
  // With Twilio Advanced Opt-Out enabled, Twilio also blocks and auto-replies.
  app.post("/webhooks/twilio/inbound", async (req, reply) => {
    if (!verify(req)) return reply.code(403).send();
    const p = req.body as TwilioParams;
    const word = (p.Body ?? "").trim().toUpperCase();
    const isStop = STOP_WORDS.has(word);
    const isStart = START_WORDS.has(word);

    const { rows } = await pool.query<{ org: string }>(
      "SELECT app.resolve_orgs_for_inbound($1, $2) AS org",
      [p.From, p.MessagingServiceSid ?? null],
    );
    for (const { org } of rows) {
      await withTenant({ orgId: org }, async (db) => {
        await db.query(
          `INSERT INTO sms_events (organization_id, twilio_message_sid, event_type, payload)
           VALUES (app.current_org_id(), $1, $2, $3)`,
          [p.MessageSid ?? null, `inbound:${isStop ? "STOP" : isStart ? "START" : "MESSAGE"}`, p],
        );
        if (isStop) {
          await db.query("UPDATE customers SET opted_out_at = now() WHERE phone_e164 = $1 AND opted_out_at IS NULL", [p.From]);
          await db.query(
            `UPDATE review_requests SET status = 'skipped', skip_reason = 'opted_out'
             WHERE to_phone = $1 AND status = 'queued'`,
            [p.From],
          );
        } else if (isStart) {
          await db.query("UPDATE customers SET opted_out_at = NULL, sms_consent = true, consent_source = 'sms_start', consent_at = now() WHERE phone_e164 = $1", [p.From]);
        }
      });
    }
    // Empty TwiML: let the Messaging Service's opt-out handling reply.
    return reply.type("text/xml").send("<Response/>");
  });
}
