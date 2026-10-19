import "dotenv/config";
import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default("info"),
  PUBLIC_API_URL: z.url(),
  APP_BASE_URL: z.url(),

  DATABASE_URL: z.string().min(1),

  AUTH_JWT_SECRET: z.string().optional(),
  AUTH_JWKS_URL: z.string().optional(),
  AUTH_JWT_ISSUER: z.string().min(1),
  AUTH_JWT_AUDIENCE: z.string().min(1),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  STATE_SIGNING_SECRET: z.string().min(32),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.url(),

  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),

  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_DEFAULT_MESSAGING_SERVICE_SID: z.string().optional(),
  TWILIO_VALIDATE_WEBHOOKS: bool,
  SMS_DRY_RUN: bool,

  MAX_UPLOAD_MB: z.coerce.number().positive().default(5),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}
if (!parsed.data.AUTH_JWT_SECRET && !parsed.data.AUTH_JWKS_URL) {
  console.error("Invalid environment: set AUTH_JWT_SECRET or AUTH_JWKS_URL");
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
