import Fastify from "fastify";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { pool } from "./db/pool.js";
import { AppError } from "./lib/errors.js";
import { billingRoutes } from "./modules/billing/routes.js";
import { googleRoutes } from "./modules/google/routes.js";
import { jobRoutes } from "./modules/jobs/routes.js";
import { mediaRoutes } from "./modules/media/routes.js";
import { organizationRoutes } from "./modules/organizations/routes.js";
import { twilioWebhookRoutes } from "./modules/webhooks/twilio.routes.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie"],
      transport: env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
    },
    trustProxy: true,
  });

  await app.register(helmet);
  await app.register(formbody); // Twilio posts application/x-www-form-urlencoded
  await app.register(multipart);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: err.issues });
    }
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    }
    req.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.code(status).send({ error: "internal_error", message: status < 500 ? (err as Error).message : "Unexpected error" });
  });

  app.get("/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true };
  });

  await app.register(organizationRoutes);
  await app.register(billingRoutes);
  await app.register(googleRoutes);
  await app.register(mediaRoutes);
  await app.register(jobRoutes);
  await app.register(twilioWebhookRoutes);

  return app;
}
