import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * Cuts a downloaded reel into the two things recognition reads: still frames
 * (for on-screen song titles) and a small audio file (for speech-to-text).
 * Both use ffmpeg, which the Docker image installs.
 */

export type Frame = {
  path: string;
  /** Roughly where in the video this frame was taken, in seconds. */
  atSeconds: number;
};

export type ToolResult = { exitCode: number | null; stdout: string; stderr: string };

/** Runs ffmpeg or ffprobe. Replaced in tests. */
export type RunTool = (tool: 'ffmpeg' | 'ffprobe', args: string[]) => Promise<ToolResult>;

export class MediaError extends Error {}

/**
 * One frame a second catches a title that is on screen for a second or more.
 * Longer reels are sampled evenly instead, so the count stays bounded.
 */
export const MAX_FRAMES = 30;

/** Tall enough to read caption-sized text, small enough to keep requests light. */
const FRAME_HEIGHT = 768;

const TOOL_TIMEOUT_MS = 60_000;

export async function probeVideo(
  videoPath: string,
  run: RunTool = runTool,
): Promise<{ durationSeconds: number; hasAudio: boolean }> {
  const duration = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const durationSeconds = Number(duration.stdout.trim());
  if (duration.exitCode !== 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaError(`could not read the video's duration: ${lastLine(duration.stderr)}`);
  }

  const audio = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0',
    videoPath,
  ]);
  return { durationSeconds, hasAudio: audio.exitCode === 0 && audio.stdout.includes('audio') };
}

/** Seconds between sampled frames for a video of this length. */
export function frameInterval(durationSeconds: number, maxFrames: number = MAX_FRAMES): number {
  return durationSeconds <= maxFrames ? 1 : durationSeconds / maxFrames;
}

export async function extractFrames(
  videoPath: string,
  dir: string,
  durationSeconds: number,
  run: RunTool = runTool,
): Promise<Frame[]> {
  const interval = frameInterval(durationSeconds);
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(durationSeconds / interval)));
  const result = await run('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vf', `fps=1/${interval.toFixed(3)},scale=-2:'min(${FRAME_HEIGHT},ih)'`,
    '-frames:v', String(count),
    '-q:v', '5',
    join(dir, 'frame-%03d.jpg'),
  ]);
  if (result.exitCode !== 0) {
    throw new MediaError(`could not extract frames: ${lastLine(result.stderr)}`);
  }
  return Array.from({ length: count }, (_, index) => ({
    path: join(dir, `frame-${String(index + 1).padStart(3, '0')}.jpg`),
    atSeconds: Math.round(index * interval),
  }));
}

/** Writes the reel's audio as a small mono MP3, which is all speech-to-text needs. */
export async function extractAudio(
  videoPath: string,
  dir: string,
  run: RunTool = runTool,
): Promise<string> {
  const path = join(dir, 'audio.mp3');
  const result = await run('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-y',
    '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k',
    path,
  ]);
  if (result.exitCode !== 0) {
    throw new MediaError(`could not extract audio: ${lastLine(result.stderr)}`);
  }
  return path;
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
}

const runTool: RunTool = (tool, args) =>
  new Promise((resolve) => {
    execFile(
      tool,
      args,
      { timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { code?: number | string };
        resolve({
          exitCode: typeof failure.code === 'number' ? failure.code : null,
          stdout,
          stderr:
            failure.code === 'ENOENT'
              ? `${tool} is not installed`
              : stderr || failure.message,
        });
      },
    );
  });
