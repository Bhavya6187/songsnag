import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Speech-to-text for a reel's audio, using OpenAI's transcription endpoint.
 * Claude reads the caption and the frames but cannot listen, so the spoken
 * part of a reel reaches it as this transcript.
 */

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'gpt-transcribe';
const TIMEOUT_MS = 90_000;

export type Transcription = { ok: true; text: string } | { ok: false; detail: string };

export type TranscribeOptions = {
  apiKey: string;
  /** Caption of the reel. Helps the model spell artist and song names it hears. */
  context?: string;
  fetchImpl?: typeof fetch;
};

export async function transcribe(audioPath: string, options: TranscribeOptions): Promise<Transcription> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const form = new FormData();
    form.set('model', MODEL);
    form.set('file', new Blob([await readFile(audioPath)], { type: 'audio/mpeg' }), basename(audioPath));
    if (options.context) form.set('prompt', options.context.slice(0, 1500));

    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}: ${errorMessage(body)}` };
    }
    const text = isRecord(body) && typeof body.text === 'string' ? body.text.trim() : null;
    if (text === null) return { ok: false, detail: 'response had no text field' };
    return { ok: true, text };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message.slice(0, 300);
  }
  return 'no error message';
}
