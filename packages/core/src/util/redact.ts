const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_RE = /\b(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3}\)?[\s-]?)\d{3}[\s-]?\d{4}\b/g;
const CC_RE = /\b(?:\d[ -]*?){13,19}\b/g;

export function redactPII(text: string): string {
  return text
    .replaceAll(EMAIL_RE, "[REDACTED_EMAIL]")
    .replaceAll(PHONE_RE, "[REDACTED_PHONE]")
    .replaceAll(CC_RE, "[REDACTED_CARD]");
}

