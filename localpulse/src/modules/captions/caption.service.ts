import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { buildCaptionUserText, CAPTION_SYSTEM_PROMPT, type CaptionContext } from "./prompt.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export const CaptionSchema = z.object({
  usable: z.boolean(),
  reason: z.string().nullable(),
  caption: z.string(),
  alt_text: z.string(),
  keywords_used: z.array(z.string()),
  category: z.enum([
    "ADDITIONAL", "AT_WORK", "EXTERIOR", "INTERIOR", "PRODUCT",
    "TEAMS", "FOOD_AND_DRINK", "MENU", "COMMON_AREA", "ROOMS",
  ]),
});
export type Caption = z.infer<typeof CaptionSchema>;

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export async function generateCaption(image: Buffer, mimeType: ImageMime, ctx: CaptionContext): Promise<Caption> {
  const response = await client.beta.messages
    .parse({
      model: env.CLAUDE_MODEL,
      max_tokens: 16000,
      // Captioning is a short, well-specified task; low effort keeps it fast/cheap.
      output_config: { effort: "low", format: zodOutputFormat(CaptionSchema) },
      // If a safety classifier declines, retry server-side on Anthropic's
      // recommended fallback model instead of failing the upload.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: CAPTION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: image.toString("base64") } },
            { type: "text", text: buildCaptionUserText(ctx) },
          ],
        },
      ],
    })
    .catch((err) => {
      // The SDK already retried 429/5xx/connection errors; surface what's left.
      if (err instanceof Anthropic.APIError) {
        throw new AppError(502, "caption_service_error", `Caption service error (${err.status ?? "network"})`);
      }
      throw err;
    });

  if (response.stop_reason === "refusal") {
    throw new AppError(422, "caption_refused", "This photo can't be captioned automatically");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new AppError(502, "caption_failed", `Caption generation failed (${response.stop_reason})`);
  // Hard cap regardless of model compliance.
  return { ...parsed, caption: parsed.caption.slice(0, 300), alt_text: parsed.alt_text.slice(0, 125) };
}
