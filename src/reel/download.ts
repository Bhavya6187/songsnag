import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Downloads a shared reel's video from its public Instagram page with yt-dlp.
 *
 * Meta's webhook delivers a reel share as a page link
 * (`https://www.instagram.com/reel/<shortcode>/`), not a video file, and its
 * API offers no way to get the media. So the file comes from the public page,
 * anonymously: no login and no cookies. Reels that Instagram only shows to
 * logged-in viewers cannot be fetched and come back as `restricted`.
 */

export type ReelDownload =
  | { ok: true; path: string; bytes: number; shortcode: string }
  | { ok: false; reason: DownloadFailure; detail: string };

export type DownloadFailure =
  /** Not a reel page link. Nothing was fetched. */
  | 'not-a-reel-url'
  /** Instagram will not show this reel without a login (age, region or private account). */
  | 'restricted'
  /** The reel was deleted or the link is wrong. */
  | 'not-found'
  /** Instagram is throttling or blocking this server. */
  | 'blocked'
  /** yt-dlp is missing, timed out, or failed some other way. */
  | 'failed';

/** Runs yt-dlp and reports what it printed. Replaced in tests. */
export type RunYtDlp = (
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export type DownloadOptions = {
  /** Directory the video is written to. Created if missing. */
  dir: string;
  run?: RunYtDlp;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 90_000;

/** Reels are short. Anything larger than this is not something to process. */
const MAX_FILE_SIZE = '150M';

const REEL_PATH = /^\/(?:reel|reels|p)\/([A-Za-z0-9_-]{5,40})\/?$/;

/**
 * Returns the reel's shortcode if `url` is an Instagram reel page, else null.
 *
 * The URL comes from a webhook body and is handed to another program, so only
 * this exact shape is accepted.
 */
export function reelShortcode(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname !== 'www.instagram.com' && parsed.hostname !== 'instagram.com') return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
  return REEL_PATH.exec(parsed.pathname)?.[1] ?? null;
}

export async function downloadReel(url: string, options: DownloadOptions): Promise<ReelDownload> {
  const shortcode = reelShortcode(url);
  if (shortcode === null) {
    return { ok: false, reason: 'not-a-reel-url', detail: 'URL is not an Instagram reel page' };
  }

  const run = options.run ?? runYtDlp;
  const path = join(options.dir, `${shortcode}.mp4`);
  await mkdir(options.dir, { recursive: true });

  const result = await run(
    [
      '--no-playlist',
      '--no-progress',
      '--no-warnings',
      '--force-overwrites',
      '--max-filesize', MAX_FILE_SIZE,
      '--socket-timeout', '20',
      '--retries', '2',
      // A single file that already holds both video and audio, so nothing has to be merged.
      '--format', 'best[ext=mp4]/best',
      '--output', path,
      '--',
      // Rebuilt from the shortcode so query strings and fragments never reach yt-dlp.
      `https://www.instagram.com/reel/${shortcode}/`,
    ],
    { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );

  if (result.timedOut) {
    return { ok: false, reason: 'failed', detail: 'yt-dlp timed out' };
  }
  if (result.exitCode !== 0) {
    const detail = lastErrorLine(result.stderr) || `yt-dlp exited with code ${result.exitCode}`;
    return { ok: false, reason: classifyFailure(detail), detail };
  }

  try {
    const info = await stat(path);
    if (info.size === 0) return { ok: false, reason: 'failed', detail: 'downloaded file is empty' };
    return { ok: true, path, bytes: info.size, shortcode };
  } catch {
    // yt-dlp exits 0 without writing a file when the video exceeds --max-filesize.
    return { ok: false, reason: 'failed', detail: 'yt-dlp wrote no file (it may be too large)' };
  }
}

/** Maps yt-dlp's error text to a reason the user can be told about. */
export function classifyFailure(detail: string): DownloadFailure {
  const text = detail.toLowerCase();
  if (
    text.includes("isn't available to everyone") ||
    text.includes('login required') ||
    text.includes('log in') ||
    text.includes('private') ||
    text.includes('restricted') ||
    text.includes('cookies')
  ) {
    return 'restricted';
  }
  if (text.includes('rate-limit') || text.includes('rate limit') || text.includes('429') || text.includes('403')) {
    return 'blocked';
  }
  if (text.includes('404') || text.includes('not found') || text.includes('unavailable') || text.includes('removed')) {
    return 'not-found';
  }
  return 'failed';
}

function lastErrorLine(stderr: string): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const error = lines.findLast((line) => line.startsWith('ERROR:'));
  return (error ?? lines.at(-1) ?? '').replace(/^ERROR:\s*/, '').slice(0, 500);
}

const runYtDlp: RunYtDlp = (args, { timeoutMs }) =>
  new Promise((resolve) => {
    const binary = process.env.YT_DLP_PATH?.trim() || 'yt-dlp';
    execFile(
      binary,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr, timedOut: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (failure.code === 'ENOENT') {
          resolve({
            exitCode: null,
            stdout,
            stderr: `ERROR: yt-dlp is not installed (looked for "${binary}"). Install it or set YT_DLP_PATH.`,
            timedOut: false,
          });
          return;
        }
        resolve({
          exitCode: typeof failure.code === 'number' ? failure.code : null,
          stdout,
          stderr,
          timedOut: failure.killed === true,
        });
      },
    );
  });
