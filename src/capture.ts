import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Writes a webhook body to `dir` byte for byte and returns the file's path.
 *
 * The bytes are kept exactly as received so a capture can be replayed against
 * the signature check and inspected for how Meta really serializes a payload.
 * Captures hold real user IDs and signed media URLs: keep them out of git.
 */
export async function captureWebhookBody(
  dir: string,
  rawBody: Uint8Array,
  now: Date = new Date(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const digest = createHash('sha256').update(rawBody).digest('hex').slice(0, 8);
  const path = join(dir, `${stamp}-${digest}.json`);
  await writeFile(path, rawBody);
  return path;
}
