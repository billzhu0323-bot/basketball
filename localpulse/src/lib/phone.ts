/**
 * Minimal E.164 normalisation. Bare 10-digit numbers are assumed to be US/CA
 * (10DLC is US-only). Swap for libphonenumber-js if you go international.
 */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  let candidate: string;
  if (trimmed.startsWith("+")) candidate = `+${digits}`;
  else if (digits.length === 10) candidate = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
  else return null;
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}
