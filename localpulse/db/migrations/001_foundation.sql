-- 001: extensions, the runtime role, and tenant-context helpers.
--
-- Migrations run as the schema OWNER (MIGRATION_DATABASE_URL). The API and
-- worker connect as `app_user`, which does NOT own any table and does NOT have
-- BYPASSRLS, so every row-level-security policy below applies to it.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    -- Password is set by scripts/migrate.ts from APP_DB_PASSWORD.
    CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- Tenant context is set per *transaction* with set_config(..., true), which is
-- safe with connection pooling (including PgBouncer transaction mode).
CREATE OR REPLACE FUNCTION app.current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
