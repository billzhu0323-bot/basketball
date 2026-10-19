import type { PoolClient } from "pg";
import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { newOAuthClient } from "./oauth.js";

const ACCOUNTS_API = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFO_API = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4_API = "https://mybusiness.googleapis.com/v4";
const UPLOAD_API = "https://mybusiness.googleapis.com/upload/v1/media";

export type GbpPhotoCategory =
  | "ADDITIONAL" | "AT_WORK" | "EXTERIOR" | "INTERIOR" | "PRODUCT"
  | "TEAMS" | "FOOD_AND_DRINK" | "MENU" | "COMMON_AREA" | "ROOMS";

interface ConnectionRow {
  id: string;
  access_token_enc: Buffer;
  refresh_token_enc: Buffer | null;
  token_expires_at: Date | null;
}

/**
 * Returns a valid access token for a connection, refreshing (and persisting
 * the new token) when it is within 2 minutes of expiry. Call inside
 * withTenant(); the refresh round-trip is short and infrequent.
 */
export async function getAccessToken(db: PoolClient, connectionId: string): Promise<string> {
  const { rows } = await db.query<ConnectionRow>(
    "SELECT id, access_token_enc, refresh_token_enc, token_expires_at FROM google_connections WHERE id = $1 AND status = 'active'",
    [connectionId],
  );
  const conn = rows[0];
  if (!conn) throw new AppError(409, "google_not_connected", "Google Business Profile is not connected");

  const fresh = conn.token_expires_at && conn.token_expires_at.getTime() - Date.now() > 120_000;
  if (fresh) return decrypt(conn.access_token_enc, env.TOKEN_ENCRYPTION_KEY);

  if (!conn.refresh_token_enc) throw new AppError(409, "google_reauth", "Reconnect Google: no refresh token");
  const client = newOAuthClient();
  client.setCredentials({ refresh_token: decrypt(conn.refresh_token_enc, env.TOKEN_ENCRYPTION_KEY) });
  try {
    const { credentials } = await client.refreshAccessToken();
    await db.query(
      "UPDATE google_connections SET access_token_enc = $2, token_expires_at = to_timestamp($3 / 1000.0), last_error = NULL WHERE id = $1",
      [conn.id, encrypt(credentials.access_token!, env.TOKEN_ENCRYPTION_KEY), credentials.expiry_date ?? Date.now() + 3_000_000],
    );
    return credentials.access_token!;
  } catch (err) {
    // invalid_grant => user revoked access in their Google account.
    await db.query("UPDATE google_connections SET status = 'error', last_error = $2 WHERE id = $1", [
      conn.id,
      String(err),
    ]);
    throw new AppError(409, "google_reauth", "Google authorization expired; reconnect required");
  }
}

async function gfetch<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new AppError(502, "google_api_error", `Google API ${res.status}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export interface GbpAccount { name: string; accountName?: string; type?: string }
export interface GbpLocation {
  name: string; // locations/123
  title: string;
  categories?: { primaryCategory?: { displayName?: string } };
  storefrontAddress?: { locality?: string; administrativeArea?: string };
  metadata?: { newReviewUri?: string; mapsUri?: string };
}

export async function listAccounts(token: string): Promise<GbpAccount[]> {
  const r = await gfetch<{ accounts?: GbpAccount[] }>(token, `${ACCOUNTS_API}/accounts`);
  return r.accounts ?? [];
}

export async function listLocations(token: string, accountName: string): Promise<GbpLocation[]> {
  const out: GbpLocation[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${INFO_API}/${accountName}/locations`);
    url.searchParams.set("readMask", "name,title,categories,storefrontAddress,metadata");
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await gfetch<{ locations?: GbpLocation[]; nextPageToken?: string }>(token, url.toString());
    out.push(...(r.locations ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Publish a photo from raw bytes using the v4 three-step upload:
 * startUpload -> upload bytes -> create MediaItem referencing the dataRef.
 */
export async function publishPhoto(
  token: string,
  args: {
    accountName: string; // accounts/123
    locationName: string; // locations/456
    bytes: Buffer;
    mimeType: string;
    description: string;
    category: GbpPhotoCategory;
  },
): Promise<{ name: string; googleUrl?: string }> {
  const locationId = args.locationName.split("/")[1];
  const parent = `${V4_API}/${args.accountName}/locations/${locationId}`;

  const { resourceName } = await gfetch<{ resourceName: string }>(token, `${parent}/media:startUpload`, {
    method: "POST",
  });

  const up = await fetch(`${UPLOAD_API}/${resourceName}?upload_type=media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": args.mimeType },
    body: new Uint8Array(args.bytes),
  });
  if (!up.ok) throw new AppError(502, "google_upload_failed", `Upload ${up.status}: ${(await up.text()).slice(0, 300)}`);

  const item = await gfetch<{ name: string; googleUrl?: string }>(token, `${parent}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mediaFormat: "PHOTO",
      locationAssociation: { category: args.category },
      dataRef: { resourceName },
      description: args.description,
    }),
  });
  return item;
}
