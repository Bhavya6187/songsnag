import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractAudioClip, type RunTool } from '../reel/media.ts';
import type { Track } from '../spotify/client.ts';

/**
 * Identifies the music playing in a reel with AudD's audio fingerprinting.
 * This is the backup for a reel that names no song anywhere: it is the only
 * step that listens to the music itself.
 *
 * One AudD request returns at most one song, so a reel is sampled in up to
 * three short clips. A reel with more than three songs yields at most three,
 * and on a long reel a song that falls between the clips is missed.
 */

const ENDPOINT = 'https://api.audd.io/';
const TIMEOUT_MS = 30_000;

/** The most AudD requests one reel may cost. */
export const MAX_REQUESTS = 3;
/** A reel shorter than this is sent whole, in one request. */
const WHOLE_REEL_SECONDS = 8;
/** Five seconds of clear music is enough for a match; this leaves room for talking. */
const CLIP_SECONDS = 12;

/** AudD error codes that mean every further request would fail the same way. */
const FATAL_CODES = new Set([900, 901]);

/** A song AudD heard. `track` is its Spotify entry when AudD supplied one. */
export type HeardSong = { title: string; artist: string | null; track: Track | null };

export type Identification =
  | { ok: true; song: HeardSong | null }
  | { ok: false; detail: string; fatal: boolean };

export type Fingerprint = {
  songs: HeardSong[];
  /** How many AudD requests were sent. */
  requests: number;
  /** One entry per clip that could not be cut or identified. */
  failures: string[];
};

export type FingerprintOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  run?: RunTool;
};

export type Clip = { startSeconds: number; lengthSeconds: number };

/**
 * Where to listen in a reel of this length: the whole of a very short reel,
 * otherwise one clip from the middle of each third.
 */
export function fingerprintClips(durationSeconds: number): Clip[] {
  if (durationSeconds < WHOLE_REEL_SECONDS) return [{ startSeconds: 0, lengthSeconds: durationSeconds }];
  const part = durationSeconds / MAX_REQUESTS;
  const lengthSeconds = Math.min(part, CLIP_SECONDS);
  return Array.from({ length: MAX_REQUESTS }, (_, index) => ({
    startSeconds: index * part + (part - lengthSeconds) / 2,
    lengthSeconds,
  }));
}

/** Never throws: a clip that fails is listed in `failures`. */
export async function fingerprintReel(
  videoPath: string,
  dir: string,
  durationSeconds: number,
  options: FingerprintOptions,
): Promise<Fingerprint> {
  const songs: HeardSong[] = [];
  const failures: string[] = [];
  let requests = 0;

  for (const [index, clip] of fingerprintClips(durationSeconds).entries()) {
    let audio: Buffer;
    try {
      const path = await extractAudioClip(videoPath, join(dir, `clip-${index + 1}.mp3`), clip, options.run);
      audio = await readFile(path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }

    requests += 1;
    const result = await identify(audio, options);
    if (!result.ok) {
      failures.push(result.detail);
      if (result.fatal) break;
      continue;
    }
    if (result.song !== null && !songs.some((known) => sameSong(known, result.song!))) {
      songs.push(result.song);
    }
  }
  return { songs, requests, failures };
}

/** One AudD request: the song playing in this audio, or null when AudD does not know it. */
export async function identify(
  audio: Buffer,
  options: { apiKey: string; fetchImpl?: typeof fetch },
): Promise<Identification> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const form = new FormData();
    form.set('api_token', options.apiKey);
    form.set('return', 'spotify');
    form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'clip.mp3');

    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body)) return { ok: false, detail: `HTTP ${response.status}: not a JSON answer`, fatal: false };
    if (body.status !== 'success') {
      const error = isRecord(body.error) ? body.error : {};
      const code = typeof error.error_code === 'number' ? error.error_code : null;
      const message = typeof error.error_message === 'string' ? error.error_message.slice(0, 300) : 'no error message';
      return { ok: false, detail: `AudD error ${code ?? 'unknown'}: ${message}`, fatal: code !== null && FATAL_CODES.has(code) };
    }
    return { ok: true, song: toSong(body.result) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error), fatal: false };
  }
}

function toSong(result: unknown): HeardSong | null {
  if (!isRecord(result) || typeof result.title !== 'string' || result.title.trim() === '') return null;
  const artist = typeof result.artist === 'string' && result.artist.trim() !== '' ? result.artist.trim() : null;
  return { title: result.title.trim(), artist, track: toTrack(result.spotify) };
}

/** The Spotify track AudD attached, if it attached a usable one. */
function toTrack(value: unknown): Track | null {
  if (!isRecord(value) || typeof value.uri !== 'string' || typeof value.name !== 'string') return null;
  if (!/^spotify:track:[A-Za-z0-9]+$/.test(value.uri)) return null;
  const artists = (Array.isArray(value.artists) ? value.artists : []).flatMap((artist) =>
    isRecord(artist) && typeof artist.name === 'string' ? [artist.name] : [],
  );
  return { uri: value.uri, name: value.name, artists };
}

function sameSong(a: HeardSong, b: HeardSong): boolean {
  if (a.track !== null && b.track !== null) return a.track.uri === b.track.uri;
  const fold = (text: string | null) => (text ?? '').trim().toLowerCase();
  return fold(a.title) === fold(b.title) && fold(a.artist) === fold(b.artist);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
