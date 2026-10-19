/**
 * Sends review requests that were deferred (send delay / quiet hours) or
 * whose inline send was interrupted. Safe to run several copies: rows are
 * claimed with FOR UPDATE SKIP LOCKED inside app.claim_due_review_requests().
 *
 *   npm run worker
 */
import { pool } from "../db/pool.js";
import { dispatchReviewRequest } from "../modules/sms/review-request.service.js";

const BATCH = 25;
const INTERVAL_MS = 15_000;
let stopping = false;

async function tick(): Promise<number> {
  const { rows } = await pool.query<{ id: string; organization_id: string }>(
    "SELECT * FROM app.claim_due_review_requests($1)",
    [BATCH],
  );
  for (const r of rows) {
    await dispatchReviewRequest({ orgId: r.organization_id }, r.id, true).catch((err) =>
      console.error(`review request ${r.id} failed`, err),
    );
  }
  return rows.length;
}

async function main() {
  console.info("review dispatcher started");
  while (!stopping) {
    const n = await tick().catch((err) => (console.error("tick failed", err), 0));
    if (n < BATCH) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  await pool.end();
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopping = true));
main();
