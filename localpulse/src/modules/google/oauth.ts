import { randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env.js";
import { signPayload, verifyPayload } from "../../lib/crypto.js";

export const GBP_SCOPES = [
  "https://www.googleapis.com/auth/business.manage",
  "openid",
  "email",
];

export const newOAuthClient = () =>
  new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  });

interface OAuthState {
  orgId: string;
  userId: string;
  nonce: string;
  exp: number; // epoch seconds
}

/**
 * The state parameter is HMAC-signed and short-lived, binding the callback to
 * the org + user that started the flow (CSRF + tenant confusion protection)
 * without a server-side session store.
 */
export function buildConsentUrl(orgId: string, userId: string): string {
  const state = signPayload(
    { orgId, userId, nonce: randomBytes(12).toString("base64url"), exp: Math.floor(Date.now() / 1000) + 600 },
    env.STATE_SIGNING_SECRET,
  );
  return newOAuthClient().generateAuthUrl({
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force refresh-token re-issue on reconnect
    include_granted_scopes: true,
    scope: GBP_SCOPES,
    state,
  });
}

export function readState(state: string): OAuthState | null {
  const s = verifyPayload<OAuthState>(state, env.STATE_SIGNING_SECRET);
  if (!s || s.exp < Date.now() / 1000) return null;
  return s;
}
