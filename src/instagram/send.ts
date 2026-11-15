/**
 * Sends a text DM from the SongSnag account.
 *
 * Under "Instagram API with Unified Login" the host is graph.facebook.com and
 * the token is the system-user token in IG_ACCESS_TOKEN. Meta only allows a
 * reply within 24 hours of the person's last message, so every reply here is
 * sent straight after the message it answers.
 */

const GRAPH_URL = 'https://graph.facebook.com/v27.0';

/** Meta's limit for message text, in UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 1000;

export type SendResult = { ok: true } | { ok: false; detail: string };

export type SendText = (igsid: string, text: string) => Promise<SendResult>;

export function createSender(config: {
  accountId: string;
  accessToken: string;
  fetch?: typeof fetch;
}): SendText {
  const doFetch = config.fetch ?? fetch;
  return async (igsid, text) => {
    for (const part of splitMessage(text)) {
      let response: Response;
      try {
        response = await doFetch(`${GRAPH_URL}/${encodeURIComponent(config.accountId)}/messages`, {
          method: 'POST',
          // The token goes in a header rather than the URL so it stays out of logs.
          headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: { id: igsid }, message: { text: part } }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        return { ok: false, detail: `network: ${String(error)}` };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return { ok: false, detail: `HTTP ${response.status}: ${body.slice(0, 300)}` };
      }
    }
    return { ok: true };
  };
}

/** Splits text into messages of at most 1000 bytes, breaking between lines where it can. */
export function splitMessage(text: string, maxBytes: number = MAX_MESSAGE_BYTES): string[] {
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const parts: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim() !== '') parts.push(current);
    current = '';
  };
  for (const line of text.split('\n')) {
    const joined = current === '' ? line : `${current}\n${line}`;
    if (bytes(joined) <= maxBytes) {
      current = joined;
      continue;
    }
    push();
    // A single line longer than the limit is cut between characters.
    for (const char of line) {
      if (bytes(current + char) > maxBytes) push();
      current += char;
    }
  }
  push();
  return parts;
}
