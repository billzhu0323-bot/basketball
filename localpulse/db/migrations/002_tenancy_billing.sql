-- 002: organizations (tenants), users, memberships, plans, subscriptions, usage.

CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'incomplete');

-- Global catalog of subscription tiers. Limits are read by the entitlement
-- layer; NULL for a limit means "unlimited".
CREATE TABLE plans (
  id                   text PRIMARY KEY,               -- 'free' | 'starter' | 'growth' | 'agency'
  name                 text NOT NULL,
  monthly_price_cents  integer NOT NULL CHECK (monthly_price_cents >= 0),
  stripe_price_id      text UNIQUE,
  limits               jsonb NOT NULL,                 -- {"photo_posts": 10, "sms": 50, "locations": 1, "seats": 1}
  is_public            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (id, name, monthly_price_cents, limits) VALUES
  ('free',    'Free',     0,     '{"photo_posts": 4,   "sms": 25,   "locations": 1,  "seats": 1}'),
  ('starter', 'Starter',  2900,  '{"photo_posts": 30,  "sms": 250,  "locations": 1,  "seats": 3}'),
  ('growth',  'Growth',   7900,  '{"photo_posts": 120, "sms": 1000, "locations": 3,  "seats": 10}'),
  ('agency',  'Agency',   19900, '{"photo_posts": null,"sms": 5000, "locations": 25, "seats": null}');

CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        citext NOT NULL UNIQUE,
  plan_id     text NOT NULL DEFAULT 'free' REFERENCES plans(id),
  timezone    text NOT NULL DEFAULT 'America/New_York',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Global identity. `auth_subject` is the `sub` claim from your identity
-- provider (Supabase Auth, Clerk, Auth0, or the dev JWT issuer).
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject  text NOT NULL UNIQUE,
  email         citext NOT NULL UNIQUE,
  full_name     text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Many users <-> many organizations; one user can belong to several businesses
-- (e.g. an agency operator).
CREATE TABLE memberships (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             membership_role NOT NULL DEFAULT 'member',
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

-- Mirror of the billing provider's subscription (one active row per org).
CREATE TABLE subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id         uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id                 text NOT NULL REFERENCES plans(id),
  status                  subscription_status NOT NULL,
  stripe_customer_id      text UNIQUE,
  stripe_subscription_id  text UNIQUE,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Metered usage per calendar month; incremented atomically against plan limits.
CREATE TABLE usage_counters (
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric           text NOT NULL,           -- 'photo_posts' | 'sms'
  period_start     date NOT NULL,
  count            integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, metric, period_start)
);

-- Machine credentials for CRM / Zapier "job completed" webhooks. Only the
-- SHA-256 of the key is stored.
CREATE TABLE api_keys (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  key_prefix       text NOT NULL,
  key_hash         bytea NOT NULL UNIQUE,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  last_used_at     timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org_idx ON api_keys (organization_id);
