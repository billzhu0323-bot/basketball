const ALLOWED_VARS = new Set(["first_name", "business_name", "review_url"]);

/** Renders {{var}} placeholders; unknown variables render empty. */
export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (ALLOWED_VARS.has(k) ? (vars[k] ?? "").trim() : ""))
    .replace(/^Hi\s*,/, "Hi,") // missing first name
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * CTIA / 10DLC hygiene: the message must identify the business and include
 * opt-out language. Validated whenever a tenant edits their template.
 */
export function validateTemplate(template: string): string[] {
  const problems: string[] = [];
  if (!template.includes("{{business_name}}")) problems.push("must include {{business_name}}");
  if (!template.includes("{{review_url}}")) problems.push("must include {{review_url}}");
  if (!/reply\s+stop/i.test(template)) problems.push('must include opt-out language such as "Reply STOP to opt out"');
  if (template.length > 320) problems.push("keep under 320 characters (2 SMS segments)");
  return problems;
}
