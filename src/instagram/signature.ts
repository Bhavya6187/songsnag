import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' };

const HEADER_PATTERN = /^sha256=([0-9a-f]{64})$/i;

/**
 * Checks Meta's `X-Hub-Signature-256` header: `sha256=` followed by the hex
 * HMAC-SHA256 of the request body, keyed with the Meta app secret.
 *
 * `rawBody` must be the bytes exactly as received. Meta signs its own
 * serialization (non-ASCII characters escaped as \uXXXX, slashes as \/), so a
 * body that has been parsed and re-serialized will not match.
 */
export function verifySignature(
  rawBody: Uint8Array,
  header: string | undefined | null,
  appSecret: string,
): SignatureResult {
  if (!header) return { ok: false, reason: 'missing' };

  const match = HEADER_PATTERN.exec(header.trim());
  if (!match?.[1]) return { ok: false, reason: 'malformed' };

  const received = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(received, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
