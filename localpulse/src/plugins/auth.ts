import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env } from "../config/env.js";
import { pool } from "../db/pool.js";
import { withUser } from "../db/tenant.js";
import { AppError, forbidden } from "../lib/errors.js";
import { sha256 } from "../lib/crypto.js";

export type Role = "owner" | "admin" | "member";

export interface Tenant {
  orgId: string;
  userId: string | null; // null for API-key (machine) requests
  role: Role | "integration";
}

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    tenant?: Tenant;
  }
}

const jwks = env.AUTH_JWKS_URL ? createRemoteJWKSet(new URL(env.AUTH_JWKS_URL)) : null;
const hsKey = env.AUTH_JWT_SECRET ? new TextEncoder().encode(env.AUTH_JWT_SECRET) : null;

async function verifyJwt(token: string): Promise<JWTPayload> {
  const opts = { issuer: env.AUTH_JWT_ISSUER, audience: env.AUTH_JWT_AUDIENCE };
  const { payload } = jwks ? await jwtVerify(token, jwks, opts) : await jwtVerify(token, hsKey!, opts);
  return payload;
}

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) throw new AppError(401, "unauthorized", "Missing bearer token");
  return h.slice(7);
}

/** Authenticates the human user only (used before an org exists, e.g. signup). */
export async function requireUser(req: FastifyRequest): Promise<void> {
  let claims: JWTPayload;
  try {
    claims = await verifyJwt(bearer(req));
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(401, "unauthorized", "Invalid token");
  }
  if (!claims.sub || typeof claims.email !== "string") {
    throw new AppError(401, "unauthorized", "Token missing sub/email");
  }
  const name = typeof claims.name === "string" ? claims.name : null;
  const { rows } = await pool.query<{ id: string }>("SELECT app.upsert_user($1, $2, $3) AS id", [
    claims.sub,
    claims.email,
    name,
  ]);
  req.userId = rows[0]!.id;
}

/**
 * Authenticates the user AND resolves the active organization from the
 * `X-Organization-Id` header, verifying membership. Every tenant route uses
 * this; downstream code reads req.tenant and passes it to withTenant().
 */
export function requireTenant(minRole: Role = "member") {
  const rank: Record<Role, number> = { member: 0, admin: 1, owner: 2 };
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    await requireUser(req);
    const orgId = req.headers["x-organization-id"];
    if (typeof orgId !== "string" || !/^[0-9a-f-]{36}$/i.test(orgId)) {
      throw new AppError(400, "missing_org", "X-Organization-Id header required");
    }
    const role = await withUser(req.userId!, async (db) => {
      const { rows } = await db.query<{ role: Role }>(
        "SELECT role FROM memberships WHERE organization_id = $1 AND user_id = $2",
        [orgId, req.userId],
      );
      return rows[0]?.role;
    });
    if (!role) throw forbidden("Not a member of this organization");
    if (rank[role] < rank[minRole]) throw forbidden(`Requires ${minRole} role`);
    req.tenant = { orgId, userId: req.userId!, role };
  };
}

/** Machine auth for CRM/Zapier integrations: `Authorization: Bearer lp_live_...`. */
export async function requireApiKey(req: FastifyRequest): Promise<void> {
  const key = bearer(req);
  if (!key.startsWith("lp_live_")) throw new AppError(401, "unauthorized", "Invalid API key");
  const { rows } = await pool.query<{ org: string | null }>("SELECT app.resolve_api_key($1) AS org", [sha256(key)]);
  const orgId = rows[0]?.org;
  if (!orgId) throw new AppError(401, "unauthorized", "Invalid API key");
  req.tenant = { orgId, userId: null, role: "integration" };
}

export function tenantOf(req: FastifyRequest): Tenant {
  if (!req.tenant) throw new Error("tenant guard not applied to this route");
  return req.tenant;
}
