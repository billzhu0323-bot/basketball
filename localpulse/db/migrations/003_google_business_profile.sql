-- 003: Google Business Profile connections, locations, and published media.

CREATE TYPE connection_status AS ENUM ('active', 'revoked', 'error');
CREATE TYPE media_post_status AS ENUM ('pending', 'captioned', 'publishing', 'published', 'failed');

-- OAuth tokens are encrypted at the application layer (AES-256-GCM,
-- TOKEN_ENCRYPTION_KEY) before they reach the database.
CREATE TABLE google_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  google_subject     text NOT NULL,                 -- Google account `sub`
  google_email       citext NOT NULL,
  access_token_enc   bytea NOT NULL,
  refresh_token_enc  bytea,
  token_expires_at   timestamptz,
  scopes             text[] NOT NULL DEFAULT '{}',
  status             connection_status NOT NULL DEFAULT 'active',
  last_error         text,
  connected_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, google_subject)
);
CREATE TRIGGER google_connections_updated_at BEFORE UPDATE ON google_connections
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE business_locations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  google_connection_id  uuid REFERENCES google_connections(id) ON DELETE SET NULL,
  gbp_account_name      text,                        -- 'accounts/123'
  gbp_location_name     text,                        -- 'locations/456'
  title                 text NOT NULL,
  primary_category      text,
  city                  text,
  region                text,
  service_keywords      text[] NOT NULL DEFAULT '{}',-- seeds for SEO captions
  review_url            text,                        -- metadata.newReviewUri from GBP
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, gbp_location_name)
);
CREATE TRIGGER business_locations_updated_at BEFORE UPDATE ON business_locations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE media_posts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id        uuid NOT NULL REFERENCES business_locations(id) ON DELETE CASCADE,
  uploaded_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  original_filename  text,
  mime_type          text NOT NULL,
  byte_size          integer NOT NULL,
  sha256             text NOT NULL,
  caption            text,
  alt_text           text,
  keywords_used      text[] NOT NULL DEFAULT '{}',
  gbp_category       text,                           -- ADDITIONAL | AT_WORK | EXTERIOR ...
  caption_model      text,
  status             media_post_status NOT NULL DEFAULT 'pending',
  gbp_media_name     text,                           -- accounts/x/locations/y/media/z
  gbp_google_url     text,
  error              text,
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_posts_org_created_idx ON media_posts (organization_id, created_at DESC);
CREATE TRIGGER media_posts_updated_at BEFORE UPDATE ON media_posts
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
