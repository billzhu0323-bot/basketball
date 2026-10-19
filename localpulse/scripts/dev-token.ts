/**
 * Mints a short-lived HS256 JWT for the seeded owner so you can hit the API
 * before wiring up a real identity provider.
 *   npm run dev:token -- [sub] [email]
 */
import "dotenv/config";
import { SignJWT } from "jose";

const [sub = "dev|owner", email = "owner@evergreendecks.test"] = process.argv.slice(2);
const secret = process.env.AUTH_JWT_SECRET;
if (!secret) throw new Error("AUTH_JWT_SECRET is required");

const token = await new SignJWT({ email, name: "Dev User" })
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(sub)
  .setIssuer(process.env.AUTH_JWT_ISSUER!)
  .setAudience(process.env.AUTH_JWT_AUDIENCE!)
  .setIssuedAt()
  .setExpirationTime("12h")
  .sign(new TextEncoder().encode(secret));

console.log(token);
