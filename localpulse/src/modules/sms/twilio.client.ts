import twilio from "twilio";
import { env } from "../../config/env.js";

const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
export const statusCallbackUrl = `${env.PUBLIC_API_URL}/webhooks/twilio/status`;

export interface SendResult { sid: string; status: string }

/**
 * Sends through a Messaging Service (required for A2P 10DLC: the service is
 * bound to the registered brand + campaign and handles sender selection and
 * STOP/HELP keywords).
 */
export async function sendSms(to: string, body: string, messagingServiceSid: string): Promise<SendResult> {
  if (env.SMS_DRY_RUN) {
    console.info(`[sms dry-run] to=${to} via=${messagingServiceSid}: ${body}`);
    return { sid: `SMdryrun${Date.now()}${Math.random().toString(16).slice(2, 10)}`, status: "sent" };
  }
  const msg = await client.messages.create({ to, body, messagingServiceSid, statusCallback: statusCallbackUrl });
  return { sid: msg.sid, status: msg.status };
}

/** Verifies X-Twilio-Signature against the exact public URL Twilio called. */
export function isValidTwilioSignature(signature: string | undefined, url: string, params: Record<string, string>) {
  if (!env.TWILIO_VALIDATE_WEBHOOKS) return true;
  return !!signature && twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params);
}
