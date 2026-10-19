-- 004: customers, jobs, review-request SMS log (Twilio / A2P 10DLC).

CREATE TYPE job_status AS ENUM ('scheduled', 'in_progress', 'completed', 'canceled');
CREATE TYPE review_request_status AS ENUM (
  'queued',       -- waiting for send_after (e.g. quiet hours)
  'sending',      -- claimed, handed to Twilio
  'sent',         -- Twilio accepted (has message SID)
  'delivered',
  'undelivered',
  'failed',
  'skipped'       -- policy decided not to send (no consent, opted out, dedupe...)
);

-- Per-tenant SMS configuration. Each org's 10DLC campaign lives behind its own
-- Twilio Messaging Service; fall back to the platform default when NULL.
CREATE TABLE sms_settings (
  organization_id        uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  messaging_service_sid  text,
  template               text NOT NULL DEFAULT
    'Hi {{first_name}}, thanks for choosing {{business_name}}! Would you leave us a quick Google review? {{review_url}} Reply STOP to opt out.',
  send_delay_minutes     integer NOT NULL DEFAULT 0 CHECK (send_delay_minutes BETWEEN 0 AND 10080),
  quiet_hours_start      smallint NOT NULL DEFAULT 21 CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end        smallint NOT NULL DEFAULT 9  CHECK (quiet_hours_end BETWEEN 0 AND 23),
  dedupe_window_days     integer NOT NULL DEFAULT 90,
  enabled                boolean NOT NULL DEFAULT true,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sms_settings_updated_at BEFORE UPDATE ON sms_settings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name       text,
  last_name        text,
  phone_e164       text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email            citext,
  -- TCPA / CTIA: record how and when consent to receive texts was obtained.
  sms_consent      boolean NOT NULL DEFAULT false,
  consent_source   text,                 -- 'invoice_checkbox' | 'verbal_at_job' | 'web_form' ...
  consent_at       timestamptz,
  opted_out_at     timestamptz,          -- set by inbound STOP
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, phone_e164)
);
CREATE TRIGGER customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id      uuid NOT NULL REFERENCES business_locations(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  external_ref     text,                 -- id in Jobber / Housecall Pro / ServiceTitan
  description      text,
  status           job_status NOT NULL DEFAULT 'scheduled',
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_ref)
);
CREATE TRIGGER jobs_updated_at BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE review_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id              uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE, -- idempotency: one per job
  customer_id         uuid NOT NULL REFERENCES customers(id),
  location_id         uuid NOT NULL REFERENCES business_locations(id),
  to_phone            text NOT NULL,
  body                text NOT NULL,
  status              review_request_status NOT NULL DEFAULT 'queued',
  skip_reason         text,
  send_after          timestamptz NOT NULL DEFAULT now(),
  attempts            integer NOT NULL DEFAULT 0,
  twilio_message_sid  text UNIQUE,
  error_code          text,
  error_message       text,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_requests_due_idx ON review_requests (send_after) WHERE status = 'queued';
CREATE INDEX review_requests_customer_idx ON review_requests (organization_id, customer_id, sent_at DESC);
CREATE TRIGGER review_requests_updated_at BEFORE UPDATE ON review_requests
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Raw, append-only log of every Twilio callback for audit/debugging.
CREATE TABLE sms_events (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  review_request_id   uuid REFERENCES review_requests(id) ON DELETE SET NULL,
  twilio_message_sid  text,
  event_type          text NOT NULL,     -- 'status:delivered' | 'inbound:STOP' ...
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_events_org_idx ON sms_events (organization_id, received_at DESC);
