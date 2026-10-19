import { describe, expect, it } from "vitest";
import { decrypt, encrypt, signPayload, verifyPayload } from "../src/lib/crypto.js";
import { toE164 } from "../src/lib/phone.js";
import { nextAllowedSendTime } from "../src/lib/time.js";
import { renderTemplate, validateTemplate } from "../src/modules/sms/template.js";

const KEY = Buffer.alloc(32, 1).toString("base64");

describe("crypto", () => {
  it("round-trips AES-GCM and rejects tampering", () => {
    const blob = encrypt("ya29.token", KEY);
    expect(decrypt(blob, KEY)).toBe("ya29.token");
    blob[blob.length - 1]! ^= 1;
    expect(() => decrypt(blob, KEY)).toThrow();
  });

  it("verifies signed state and rejects a forged one", () => {
    const tok = signPayload({ orgId: "a" }, "s".repeat(32));
    expect(verifyPayload(tok, "s".repeat(32))).toEqual({ orgId: "a" });
    const [body] = tok.split(".");
    const forged = Buffer.from(JSON.stringify({ orgId: "b" })).toString("base64url");
    expect(verifyPayload(`${forged}.${tok.split(".")[1]}`, "s".repeat(32))).toBeNull();
    expect(verifyPayload(`${body}.x`, "s".repeat(32))).toBeNull();
  });
});

describe("phone", () => {
  it("normalises US numbers to E.164", () => {
    expect(toE164("(206) 555-0123")).toBe("+12065550123");
    expect(toE164("1-206-555-0123")).toBe("+12065550123");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("555-0123")).toBeNull();
  });
});

describe("quiet hours", () => {
  const tz = "America/Los_Angeles";
  it("sends immediately during allowed hours", () => {
    const noonPT = new Date("2026-06-15T19:00:00Z");
    expect(nextAllowedSendTime(noonPT, tz, 21, 9)).toEqual(noonPT);
  });
  it("defers a late-night send to 9am local", () => {
    const elevenPmPT = new Date("2026-06-16T06:00:00Z");
    expect(nextAllowedSendTime(elevenPmPT, tz, 21, 9).toISOString()).toBe("2026-06-16T16:00:00.000Z");
  });
});

describe("sms template", () => {
  const tpl = "Hi {{first_name}}, thanks for choosing {{business_name}}! {{review_url}} Reply STOP to opt out.";
  it("renders variables and handles a missing first name", () => {
    expect(renderTemplate(tpl, { first_name: "Sam", business_name: "Evergreen", review_url: "https://g.page/r/x" }))
      .toBe("Hi Sam, thanks for choosing Evergreen! https://g.page/r/x Reply STOP to opt out.");
    expect(renderTemplate(tpl, { business_name: "Evergreen", review_url: "u" })).toMatch(/^Hi, thanks/);
  });
  it("enforces 10DLC content rules", () => {
    expect(validateTemplate(tpl)).toEqual([]);
    expect(validateTemplate("Leave us a review! {{review_url}}")).toHaveLength(2);
  });
});
