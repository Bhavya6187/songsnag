import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadReel, type DownloadFailure } from '../reel/download.ts';
import { extractAudio, extractFrames, MediaError, probeVideo } from '../reel/media.ts';
import { fingerprintReel, type HeardSong } from './fingerprint.ts';
import { extractSongs, type Song, type SongExtraction } from './songs.ts';
import { transcribe } from './transcribe.ts';

/**
 * The whole recognition step for one shared reel: download it, read its
 * caption, its frames and its speech, and return the songs it names.
 *
 * The caption and frames are enough to proceed, so a failed or unavailable
 * transcript is recorded in `notes` rather than failing the reel. Everything
 * downloaded or cut from the reel is deleted before this returns.
 *
 * When the reel names no song at all, and an AudD key is set, the music
 * playing in it is identified by audio fingerprinting instead. That is a
 * backup only: a reel that names songs is never fingerprinted.
 */

export type Recognition =
  | {
      ok: true;
      /** The songs the reel names. */
      songs: Song[];
      /** Songs identified from the music playing, filled only when `songs` is empty. */
      heard: HeardSong[];
      /** Which sources were actually read. `fingerprint` is the number of AudD requests sent. */
      used: { caption: boolean; frames: number; transcript: boolean; fingerprint: number };
      /** Sources that were skipped or failed, and why. */
      notes: string[];
      /** Fingerprinting ran and part of it failed, so an empty answer may not be the final one. */
      fingerprintFailed: boolean;
      /** Token counts for the Claude request, when one was made. */
      usage?: { inputTokens: number; outputTokens: number; model: string };
    }
  | { ok: false; stage: 'download'; reason: DownloadFailure; detail: string }
  | { ok: false; stage: 'media'; reason: 'failed'; detail: string }
  | { ok: false; stage: 'extract'; reason: Exclude<SongExtraction, { ok: true }>['reason']; detail: string };

export type RecognizeInput = {
  /** The reel's page link, from the webhook. */
  url: string;
  /** The reel's caption, from the webhook's `title`. */
  caption: string | null;
};

export type RecognizeOptions = {
  /** OpenAI API key for speech-to-text. Without one, speech is skipped. */
  openaiApiKey: string | null;
  /** AudD API key for fingerprinting a reel that names no song. Without one, that step is skipped. */
  auddApiKey?: string | null;
  /** Replaceable steps, for tests. */
  steps?: Partial<Steps>;
};

type Steps = {
  downloadReel: typeof downloadReel;
  probeVideo: typeof probeVideo;
  extractFrames: typeof extractFrames;
  extractAudio: typeof extractAudio;
  transcribe: typeof transcribe;
  extractSongs: typeof extractSongs;
  fingerprintReel: typeof fingerprintReel;
};

const defaultSteps: Steps = {
  downloadReel,
  probeVideo,
  extractFrames,
  extractAudio,
  transcribe,
  extractSongs,
  fingerprintReel,
};

export async function recognizeReel(input: RecognizeInput, options: RecognizeOptions): Promise<Recognition> {
  const steps = { ...defaultSteps, ...options.steps };
  const workDir = await mkdtemp(join(tmpdir(), 'songsnag-'));
  const notes: string[] = [];

  try {
    const download = await steps.downloadReel(input.url, { dir: workDir });
    if (!download.ok) {
      return { ok: false, stage: 'download', reason: download.reason, detail: download.detail };
    }

    let frames: { jpeg: Buffer; atSeconds: number }[] = [];
    let transcript: string | null = null;
    let video: { durationSeconds: number; hasAudio: boolean };
    try {
      video = await steps.probeVideo(download.path);
      const framePaths = await steps.extractFrames(download.path, workDir, video.durationSeconds);
      frames = (
        await Promise.all(
          framePaths.map(async (frame) => {
            // ffmpeg can write one frame fewer than asked for at the very end of a video.
            const jpeg = await readFile(frame.path).catch(() => null);
            return jpeg === null ? [] : [{ jpeg, atSeconds: frame.atSeconds }];
          }),
        )
      ).flat();

      if (!video.hasAudio) {
        notes.push('speech skipped: the reel has no audio');
      } else if (options.openaiApiKey === null) {
        notes.push('speech skipped: OPENAI_API_KEY is not set');
      } else {
        const audioPath = await steps.extractAudio(download.path, workDir);
        const result = await steps.transcribe(audioPath, {
          apiKey: options.openaiApiKey,
          context: input.caption ?? undefined,
        });
        if (result.ok) transcript = result.text;
        else notes.push(`speech skipped: transcription failed (${result.detail})`);
      }
    } catch (error) {
      if (!(error instanceof MediaError)) throw error;
      return { ok: false, stage: 'media', reason: 'failed', detail: error.message };
    }

    const extraction = await steps.extractSongs({ caption: input.caption, transcript, frames });
    if (!extraction.ok) {
      return { ok: false, stage: 'extract', reason: extraction.reason, detail: extraction.detail };
    }

    let heard: HeardSong[] = [];
    let fingerprintRequests = 0;
    let fingerprintFailed = false;
    const auddApiKey = options.auddApiKey ?? null;
    if (extraction.songs.length === 0 && video.hasAudio && auddApiKey !== null) {
      try {
        const fingerprint = await steps.fingerprintReel(download.path, workDir, video.durationSeconds, {
          apiKey: auddApiKey,
        });
        heard = fingerprint.songs;
        fingerprintRequests = fingerprint.requests;
        fingerprintFailed = fingerprint.failures.length > 0;
        for (const failure of fingerprint.failures) notes.push(`fingerprinting failed: ${failure}`);
      } catch (error) {
        fingerprintFailed = true;
        notes.push(`fingerprinting failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      ok: true,
      songs: extraction.songs,
      heard,
      used: {
        caption: Boolean(input.caption?.trim()),
        frames: frames.length,
        transcript: Boolean(transcript?.trim()),
        fingerprint: fingerprintRequests,
      },
      notes,
      fingerprintFailed,
      ...(extraction.usage ? { usage: extraction.usage } : {}),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
