import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      PUBLIC_API_URL: "http://localhost:3000",
      APP_BASE_URL: "http://localhost:5173",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://app_user:app_user_dev_pw@localhost:5432/localpulse",
      AUTH_JWT_SECRET: "test-secret-test-secret-test-secret",
      AUTH_JWT_ISSUER: "localpulse-dev",
      AUTH_JWT_AUDIENCE: "localpulse-api",
      TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      STATE_SIGNING_SECRET: "state-secret-state-secret-state-secret",
      GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "x",
      GOOGLE_REDIRECT_URI: "http://localhost:3000/v1/google/oauth/callback",
      ANTHROPIC_API_KEY: "x", TWILIO_ACCOUNT_SID: "ACx", TWILIO_AUTH_TOKEN: "x",
      SMS_DRY_RUN: "true",
    },
  },
});
