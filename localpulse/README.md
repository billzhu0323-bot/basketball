# LocalPulse

Backend for a micro-SaaS that helps local service businesses:

1. **Publish photos to Google Business Profile** with AI-written local-SEO captions.
2. **Text customers a Google review link** as soon as a job is marked complete (Twilio, A2P 10DLC).
3. **Run many businesses on one platform**: several users per organization, Postgres row-level-security isolation, and tiered monthly plans.

**Stack:** Node.js 20+ · TypeScript · Fastify 5 · PostgreSQL 16 (plain SQL + RLS, works on Supabase) · Claude (`@anthropic-ai/sdk`) · Twilio · Google OAuth 2.0.

## Quick start

```bash
cd localpulse
npm run setup        # .env with fresh secrets → docker Postgres → npm install → migrate → seed
npm run dev          # API on :3000
npm run worker       # review-SMS dispatcher (deferred / retried sends)
npm run dev:token    # prints a JWT for the seeded owner
npm test             # unit tests; RUN_DB_TESTS=1 also runs the RLS isolation tests
```

Already have Postgres? Point the two URLs in `.env` at it and run `SKIP_DOCKER=1 npm run setup`.

```bash
TOKEN=$(npm run -s dev:token)
ORG=<org id printed by the seed>
curl localhost:3000/v1/me/organizations -H "Authorization: Bearer $TOKEN"
curl localhost:3000/v1/billing/usage -H "Authorization: Bearer $TOKEN" -H "X-Organization-Id: $ORG"
```

`SMS_DRY_RUN=true` (the default in `.env.example`) logs texts instead of sending them. That lets you run the whole SMS flow without Twilio credentials.

## Layout

```
localpulse/
├── db/migrations/
│   ├── 001_foundation.sql              extensions, app_user role, tenant-context helpers
│   ├── 002_tenancy_billing.sql         plans, organizations, users, memberships, subscriptions, usage, api_keys
│   ├── 003_google_business_profile.sql google_connections (encrypted tokens), business_locations, media_posts
│   ├── 004_sms_review_requests.sql     sms_settings, customers (consent), jobs, review_requests, sms_events
│   └── 005_row_level_security.sql      RLS policies, grants, SECURITY DEFINER entry points
├── scripts/      setup.sh · migrate.ts · seed.ts · dev-token.ts
├── src/
│   ├── app.ts / server.ts              Fastify app + error mapping
│   ├── config/env.ts                   zod-validated environment
│   ├── db/pool.ts, db/tenant.ts        withTenant(): per-transaction RLS context
│   ├── lib/                            crypto (AES-GCM, HMAC state, API keys), phone, quiet-hours time, errors
│   ├── plugins/auth.ts                 JWT user auth, org membership/role guard, API-key auth
│   ├── modules/
│   │   ├── organizations/              signup, org switcher, members (seat-capped), API keys
│   │   ├── billing/                    plan entitlements + atomic monthly quota
│   │   ├── google/                     OAuth2 connect, token refresh, GBP accounts/locations/media client
│   │   ├── captions/                   Claude caption prompt + structured-output call
│   │   ├── media/                      photo upload → caption → publish pipeline
│   │   ├── sms/                        Twilio client, template rules, review-request policy + dispatch
│   │   ├── jobs/                       jobs/customers API, "job completed" trigger (user + integration)
│   │   └── webhooks/                   Twilio delivery status + inbound STOP/START
│   └── workers/review-dispatcher.ts    sends due/deferred review requests (SKIP LOCKED)
└── test/         unit.test.ts · rls.test.ts
```

## Workflow 1: Google Business Profile photos

| Route | Purpose |
|---|---|
| `GET /v1/google/oauth/start` (admin) | Returns the Google consent URL (`business.manage`, offline access). |
| `GET /v1/google/oauth/callback` | Google redirects here. Verifies the HMAC-signed `state` (org + user + 10-minute expiry), exchanges the code, verifies the ID token, and stores AES-256-GCM-encrypted tokens. |
| `POST /v1/google/locations/sync` (admin) | Imports accounts and locations, including `metadata.newReviewUri`, which becomes the review link the SMS workflow sends. Capped by the plan's `locations` limit. |
| `POST /v1/locations/:id/photos` | Multipart `file` plus optional `hint` and `dry_run=true`. Reserves quota, has Claude write the caption, alt text, keywords and GBP category, then publishes through the v4 `media:startUpload` → upload bytes → `media.create` flow. |
| `GET /v1/photos` | Recent posts with status and errors. |

How it fits together:
- **Caption prompt:** `src/modules/captions/prompt.ts`. It describes only what's visible, uses at most two natural keywords plus the city, stays under 250 characters, and follows Google's photo policy (no phone numbers, URLs, hashtags or promos). It also flags unusable photos.
- **Claude call:** structured output validated with zod, `effort: "low"`, and a cached system prompt. `fallbacks: "default"` reruns the request on Anthropic's recommended fallback model if a safety classifier declines it.
- **Short transactions:** each database step is its own short transaction. No connection stays open while Claude or Google is working. If a step fails, the post is marked `failed` and the quota unit is refunded.

## Workflow 2: Review-request SMS (Twilio / 10DLC)

| Route | Purpose |
|---|---|
| `POST /v1/jobs` | Creates or updates a customer (E.164 phone, consent source and time) and a job. |
| `POST /v1/jobs/:id/complete` | **The trigger.** Marks the job complete, applies the send policy, and sends right away when allowed. |
| `POST /v1/integrations/job-completed` | The same trigger for Jobber, Housecall Pro or Zapier, authenticated with an org API key (`Bearer lp_live_…`). |
| `PUT /v1/sms/settings` (admin) | Messaging Service SID, template, delay, quiet hours. Templates must name the business, include the review link, and include "Reply STOP". |
| `GET /v1/review-requests` | Log with status, skip reason and delivery time. |
| `POST /webhooks/twilio/status` | Delivery receipts. Checks `X-Twilio-Signature`. Status never moves backwards when callbacks arrive out of order. |
| `POST /webhooks/twilio/inbound` | Records STOP and START, and cancels anything already queued for that number. |

**Send policy** (`review-request.service.ts`). A text goes out only if:
- the job is completed and SMS is enabled for the org;
- the customer has given consent and hasn't opted out;
- the location has a review URL;
- the customer hasn't had a request in the last 90 days (configurable);
- the send time falls outside quiet hours, which default to 9pm–9am in the org's time zone. Otherwise it's queued until quiet hours end;
- the plan's monthly SMS quota isn't used up.

A request that fails a check is stored as `skipped` with the reason. `review_requests.job_id` is unique, so calling the trigger twice never sends twice. Opt-out and dedupe are checked again right before sending.

## Workflow 3: Multi-tenancy and subscriptions

- **Data model:** `organizations` 1─* `memberships` *─1 `users`, with roles `owner`, `admin` and `member`. One user can belong to several businesses (useful for agencies). Every tenant table has an `organization_id` column.
- **Isolation is enforced by Postgres, not just by app code.** The API connects as `app_user`, which owns no tables and has no BYPASSRLS. Every tenant table has a policy `organization_id = app.current_org_id()`. `withTenant()` sets that value per transaction with `set_config(..., true)`, which is safe with connection pooling and PgBouncer. If a query runs without a tenant context it gets no rows; it never sees all of them. `test/rls.test.ts` checks reads, cross-tenant inserts and updates, and missing context.
- **Cross-tenant lookups** go through a few narrow `SECURITY DEFINER` functions in schema `app`: user upsert, org creation, org switcher, API-key lookup, MessageSid → org, inbound phone → orgs, and worker claims.
- **Plans:**

  | Plan | Price | Photo posts / mo | SMS / mo | Locations | Seats |
  |---|---|---|---|---|---|
  | free | $0 | 4 | 25 | 1 | 1 |
  | starter | $29 | 30 | 250 | 1 | 3 |
  | growth | $79 | 120 | 1,000 | 3 | 10 |
  | agency | $199 | unlimited | 5,000 | 25 | unlimited |

  Limits live in `plans.limits` (jsonb). `consumeQuota()` is a single conditional upsert into `usage_counters`, so two requests at the same moment can't both slip past the cap. A subscription that is `canceled`, `incomplete`, or `past_due` for more than 7 days falls back to free-tier limits.
- Clients send `X-Organization-Id`, and `requireTenant(role)` checks membership and role on every request.

## Before production

- **Auth:** replace the dev HS256 issuer with your identity provider by setting `AUTH_JWKS_URL` (Supabase Auth, Clerk or Auth0). Users are created on first request from `sub` and `email`.
- **Billing:** the Stripe webhook is a TODO in `modules/billing/routes.ts`. Verify the signature, upsert `subscriptions`, and set `organizations.plan_id`.
- **Google:** GBP API access requires Google's approval of your Cloud project, and the OAuth consent screen needs verification for the `business.manage` scope.
- **Twilio 10DLC:** register a Brand and Campaign (use case "Customer Care" or "Marketing", with sample messages that match your template), attach it to a Messaging Service, and turn on Advanced Opt-Out. Each tenant either gets its own service (`sms_settings.messaging_service_sid`) or shares the platform's.
- **Stuck sends:** a request stuck in `sending` (process crashed mid-send) isn't retried automatically yet. Add a sweeper that resets old `sending` rows after checking Twilio by recipient and time.
- **Photo storage:** photos aren't stored. Add object storage (S3, R2 or Supabase Storage) if you want drafts to review and publish later.
- **Phone numbers:** `lib/phone.ts` is US-focused. Use `libphonenumber-js` to support other countries.
