import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { withTenant } from "../../db/tenant.js";
import { AppError, badRequest, notFound } from "../../lib/errors.js";
import { requireTenant, tenantOf } from "../../plugins/auth.js";
import { consumeQuota, refundQuota } from "../billing/entitlements.js";
import { generateCaption, type ImageMime } from "../captions/caption.service.js";
import { getAccessToken, publishPhoto, type GbpPhotoCategory } from "../google/gbp.client.js";

const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp"]);
const PUBLISHABLE = new Set(["image/jpeg", "image/png"]); // GBP accepts JPG/PNG
const MIN_BYTES = 10 * 1024; // GBP minimum

export async function mediaRoutes(app: FastifyInstance) {
  /**
   * POST /v1/locations/:locationId/photos  (multipart/form-data)
   *   file      - required image
   *   hint      - optional owner note ("finished deck, cedar")
   *   dry_run   - "true" to generate the caption without publishing
   *
   * Pipeline: validate -> reserve quota -> caption (Claude) -> publish (GBP).
   * Each DB step is its own short transaction; network calls happen between
   * them so no connection is held during Claude/Google latency.
   */
  app.post<{ Params: { locationId: string } }>(
    "/v1/locations/:locationId/photos",
    { preHandler: requireTenant("member") },
    async (req, reply) => {
      const t = tenantOf(req);
      const locationId = z.uuid().parse(req.params.locationId);

      const fields: Record<string, string> = {};
      let file: { bytes: Buffer; mime: string; filename: string } | null = null;
      for await (const part of req.parts({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } })) {
        if (part.type === "file") {
          const bytes = await part.toBuffer();
          if (part.file.truncated) throw new AppError(413, "too_large", `Max ${env.MAX_UPLOAD_MB} MB`);
          file = { bytes, mime: part.mimetype, filename: part.filename };
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      if (!file) throw badRequest("file is required");
      if (!ALLOWED.has(file.mime)) throw badRequest("Only JPEG, PNG, or WebP images are accepted");
      if (file.bytes.length < MIN_BYTES) throw badRequest("Image is too small for Google (min 10 KB)");
      const dryRun = fields.dry_run === "true";
      if (!dryRun && !PUBLISHABLE.has(file.mime)) throw badRequest("Google only accepts JPEG or PNG for publishing");

      // Tx 1: load location, reserve quota, create the pending row.
      const { post, location } = await withTenant(t, async (db) => {
        const { rows } = await db.query(
          `SELECT id, title, primary_category, city, region, service_keywords,
                  google_connection_id, gbp_account_name, gbp_location_name
           FROM business_locations WHERE id = $1 AND is_active`,
          [locationId],
        );
        const location = rows[0];
        if (!location) throw notFound("Location");
        if (!dryRun) await consumeQuota(db, "photo_posts");
        const { rows: p } = await db.query(
          `INSERT INTO media_posts (organization_id, location_id, uploaded_by, original_filename, mime_type, byte_size, sha256)
           VALUES (app.current_org_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
          [locationId, t.userId, file!.filename, file!.mime, file!.bytes.length, createHash("sha256").update(file!.bytes).digest("hex")],
        );
        return { post: p[0] as { id: string }, location };
      });

      const fail = async (err: unknown) => {
        await withTenant(t, async (db) => {
          await db.query("UPDATE media_posts SET status = 'failed', error = $2 WHERE id = $1", [post.id, String(err)]);
          if (!dryRun) await refundQuota(db, "photo_posts");
        });
        throw err;
      };

      // Claude: caption + category.
      const caption = await generateCaption(file.bytes, file.mime as ImageMime, {
        businessName: location.title,
        primaryCategory: location.primary_category,
        city: location.city,
        region: location.region,
        serviceKeywords: location.service_keywords,
        userHint: fields.hint?.slice(0, 300),
      }).catch(fail);

      await withTenant(t, (db) =>
        db.query(
          `UPDATE media_posts SET status = 'captioned', caption = $2, alt_text = $3, keywords_used = $4,
                  gbp_category = $5, caption_model = $6 WHERE id = $1`,
          [post.id, caption.caption, caption.alt_text, caption.keywords_used, caption.category, env.CLAUDE_MODEL],
        ),
      );

      if (dryRun) return reply.send({ id: post.id, status: "captioned", ...caption });
      if (!caption.usable) {
        await fail(new AppError(422, "photo_unusable", caption.reason ?? "Photo isn't suitable for a business profile"));
      }

      // Google: refresh token if needed (short tx), then upload outside any tx.
      const token = await withTenant(t, async (db) => {
        await db.query("UPDATE media_posts SET status = 'publishing' WHERE id = $1", [post.id]);
        if (!location.google_connection_id) throw badRequest("Location isn't linked to Google; run a location sync");
        return getAccessToken(db, location.google_connection_id);
      }).catch(fail);

      const media = await publishPhoto(token, {
        accountName: location.gbp_account_name,
        locationName: location.gbp_location_name,
        bytes: file.bytes,
        mimeType: file.mime,
        description: caption.caption,
        category: caption.category as GbpPhotoCategory,
      }).catch(fail);

      await withTenant(t, (db) =>
        db.query(
          `UPDATE media_posts SET status = 'published', gbp_media_name = $2, gbp_google_url = $3, published_at = now()
           WHERE id = $1`,
          [post.id, media.name, media.googleUrl ?? null],
        ),
      );
      return reply.code(201).send({ id: post.id, status: "published", gbp_media_name: media.name, ...caption });
    },
  );

  app.get("/v1/photos", { preHandler: requireTenant() }, async (req) =>
    withTenant(tenantOf(req), async (db) => {
      const { rows } = await db.query(
        `SELECT id, location_id, status, caption, gbp_category, gbp_google_url, error, created_at, published_at
         FROM media_posts ORDER BY created_at DESC LIMIT 50`,
      );
      return { photos: rows };
    }),
  );
}
