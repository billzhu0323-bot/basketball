-- 005: row-level security, grants, and narrow SECURITY DEFINER entry points.
--
-- Rule: every tenant-owned table carries organization_id and is readable /
-- writable by app_user ONLY for rows where organization_id matches the
-- transaction's app.org_id. A missing context matches nothing (NULL = x is
-- never true), so forgetting withTenant() fails closed.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'subscriptions', 'usage_counters', 'api_keys',
    'google_connections', 'business_locations', 'media_posts',
    'sms_settings', 'customers', 'jobs', 'review_requests', 'sms_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (organization_id = app.current_org_id())
         WITH CHECK (organization_id = app.current_org_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;

GRANT USAGE ON SEQUENCE sms_events_id_seq TO app_user;

-- organizations: a tenant sees and edits only itself. Creation goes through
-- app.create_organization() so a caller can never mint rows for other users.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_self ON organizations
  USING (id = app.current_org_id())
  WITH CHECK (id = app.current_org_id());
GRANT SELECT, UPDATE (name, timezone) ON organizations TO app_user;

-- memberships: visible within the current org, plus the caller's own rows
-- (needed to resolve which orgs a user may switch into).
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY membership_read ON memberships FOR SELECT
  USING (organization_id = app.current_org_id() OR user_id = app.current_user_id());
CREATE POLICY membership_write ON memberships FOR INSERT
  WITH CHECK (organization_id = app.current_org_id());
CREATE POLICY membership_update ON memberships FOR UPDATE
  USING (organization_id = app.current_org_id());
CREATE POLICY membership_delete ON memberships FOR DELETE
  USING (organization_id = app.current_org_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO app_user;

-- users: you can see yourself and teammates in the current org.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_visible ON users FOR SELECT
  USING (
    id = app.current_user_id()
    OR id IN (SELECT user_id FROM memberships WHERE organization_id = app.current_org_id())
  );
CREATE POLICY users_self_update ON users FOR UPDATE
  USING (id = app.current_user_id());
GRANT SELECT, UPDATE (full_name) ON users TO app_user;

GRANT SELECT ON plans TO app_user;

----------------------------------------------------------------------------
-- SECURITY DEFINER functions: the only cross-tenant doors, each answering one
-- narrow question. They run as the owner, so keep search_path pinned.
----------------------------------------------------------------------------

-- Called on every authenticated request: map IdP subject -> users.id.
CREATE FUNCTION app.upsert_user(p_subject text, p_email text, p_full_name text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO users (auth_subject, email, full_name)
  VALUES (p_subject, p_email, p_full_name)
  ON CONFLICT (auth_subject) DO UPDATE
    SET email = EXCLUDED.email,
        full_name = COALESCE(EXCLUDED.full_name, users.full_name)
  RETURNING id
$$;

-- Signup: create a tenant with the caller as owner, plus default settings.
CREATE FUNCTION app.create_organization(p_owner uuid, p_name text, p_slug text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_org uuid;
BEGIN
  INSERT INTO organizations (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_org;
  INSERT INTO memberships (organization_id, user_id, role) VALUES (v_org, p_owner, 'owner');
  INSERT INTO sms_settings (organization_id) VALUES (v_org);
  RETURN v_org;
END $$;

-- Org switcher: the caller's own organizations (organizations RLS otherwise
-- exposes only the current org).
CREATE FUNCTION app.my_organizations()
RETURNS TABLE (id uuid, name text, slug citext, plan_id text, role membership_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.name, o.slug, o.plan_id, m.role
  FROM memberships m JOIN organizations o ON o.id = m.organization_id
  WHERE m.user_id = app.current_user_id()
  ORDER BY o.name
$$;

-- Machine auth for integration webhooks.
CREATE FUNCTION app.resolve_api_key(p_hash bytea)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE api_keys SET last_used_at = now()
  WHERE key_hash = p_hash AND revoked_at IS NULL
  RETURNING organization_id
$$;

-- Twilio status callbacks carry only a MessageSid.
CREATE FUNCTION app.resolve_org_for_message_sid(p_sid text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT organization_id FROM review_requests WHERE twilio_message_sid = p_sid
$$;

-- Inbound STOP/START: a phone number may be a customer of several tenants
-- that share one sending number, so return every match.
CREATE FUNCTION app.resolve_orgs_for_inbound(p_from text, p_messaging_service_sid text)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.organization_id
  FROM customers c
  LEFT JOIN sms_settings s ON s.organization_id = c.organization_id
  WHERE c.phone_e164 = p_from
    AND (p_messaging_service_sid IS NULL
         OR s.messaging_service_sid IS NULL
         OR s.messaging_service_sid = p_messaging_service_sid)
$$;

-- Worker: claim due review requests across tenants (SKIP LOCKED so several
-- workers can run). Returns ids only; processing happens under withTenant().
CREATE FUNCTION app.claim_due_review_requests(p_limit integer)
RETURNS TABLE (id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE review_requests r
  SET status = 'sending', attempts = r.attempts + 1
  WHERE r.id IN (
    SELECT q.id FROM review_requests q
    WHERE q.status = 'queued' AND q.send_after <= now()
    ORDER BY q.send_after
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING r.id, r.organization_id
$$;

REVOKE ALL ON FUNCTION
  app.upsert_user(text, text, text),
  app.create_organization(uuid, text, text),
  app.my_organizations(),
  app.resolve_api_key(bytea),
  app.resolve_org_for_message_sid(text),
  app.resolve_orgs_for_inbound(text, text),
  app.claim_due_review_requests(integer)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.upsert_user(text, text, text),
  app.create_organization(uuid, text, text),
  app.my_organizations(),
  app.resolve_api_key(bytea),
  app.resolve_org_for_message_sid(text),
  app.resolve_orgs_for_inbound(text, text),
  app.claim_due_review_requests(integer)
TO app_user;
