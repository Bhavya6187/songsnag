import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classifyFailure, downloadReel, reelShortcode, type RunYtDlp } from '../src/reel/download.ts';

test('reelShortcode accepts reel page links and nothing else', () => {
  assert.equal(reelShortcode('https://www.instagram.com/reel/SHORTCODE01/'), 'SHORTCODE01');
  assert.equal(reelShortcode('https://www.instagram.com/reel/Ab_c-123'), 'Ab_c-123');
  assert.equal(reelShortcode('https://instagram.com/reels/SHORTCODE01/?igsh=abc'), 'SHORTCODE01');
  for (const url of [
    'http://www.instagram.com/reel/SHORTCODE01/',
    'https://www.instagram.com.evil.example/reel/SHORTCODE01/',
    'https://evil.example/reel/SHORTCODE01/',
    'https://user@www.instagram.com/reel/SHORTCODE01/',
    'https://www.instagram.com/reel/SHORTCODE01/extra',
    'https://www.instagram.com/someuser/',
    'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1',
    '--exec=rm',
    '',
  ]) {
    assert.equal(reelShortcode(url), null, url);
  }
});

async function withTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'songsnag-reel-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a successful download reports the file, and yt-dlp only ever sees a rebuilt URL', async () => {
  await withTempDir(async (dir) => {
    let seen: string[] = [];
    const run: RunYtDlp = async (args) => {
      seen = args;
      await writeFile(args[args.indexOf('--output') + 1]!, 'video-bytes');
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const result = await downloadReel('https://www.instagram.com/reel/SHORTCODE01/?igsh=x#frag', { dir, run });
    assert.deepEqual(result, {
      ok: true,
      path: join(dir, 'SHORTCODE01.mp4'),
      bytes: 11,
      shortcode: 'SHORTCODE01',
    });
    assert.equal(seen.at(-1), 'https://www.instagram.com/reel/SHORTCODE01/');
    assert.equal(seen.at(-2), '--');
    assert.ok(!seen.includes('--cookies') && !seen.includes('--cookies-from-browser'));
  });
});

test('anything that is not a reel link is refused without running yt-dlp', async () => {
  await withTempDir(async (dir) => {
    let ran = false;
    const run: RunYtDlp = async () => {
      ran = true;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const result = await downloadReel('https://example.com/video.mp4', { dir, run });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'not-a-reel-url');
    assert.equal(ran, false);
  });
});

test('a reel Instagram hides from logged-out viewers comes back as restricted', async () => {
  await withTempDir(async (dir) => {
    // The error yt-dlp printed for a real audience-restricted reel on 2026-11-14.
    const stderr =
      "ERROR: [Instagram] SHORTCODE01: This content isn't available to everyone: It can't be seen by certain audiences.\n";
    const run: RunYtDlp = async () => ({ exitCode: 1, stdout: '', stderr, timedOut: false });
    const result = await downloadReel('https://www.instagram.com/reel/SHORTCODE01/', { dir, run });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, 'restricted');
  });
});

test('timeouts, missing files and other errors are reported, never thrown', async () => {
  await withTempDir(async (dir) => {
    const url = 'https://www.instagram.com/reel/SHORTCODE01/';
    const timedOut = await downloadReel(url, {
      dir,
      run: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
    });
    assert.deepEqual(timedOut, { ok: false, reason: 'failed', detail: 'yt-dlp timed out' });

    const noFile = await downloadReel(url, {
      dir,
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    });
    assert.equal(!noFile.ok && noFile.reason, 'failed');

    const other = await downloadReel(url, {
      dir,
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'ERROR: something odd\n', timedOut: false }),
    });
    assert.deepEqual(other, { ok: false, reason: 'failed', detail: 'something odd' });
  });
});

test('classifyFailure sorts yt-dlp errors into reasons', () => {
  assert.equal(classifyFailure('Requested content is not available, rate-limit reached or login required'), 'restricted');
  assert.equal(classifyFailure('HTTP Error 429: Too Many Requests'), 'blocked');
  assert.equal(classifyFailure('HTTP Error 404: Not Found'), 'not-found');
  assert.equal(classifyFailure('Unable to extract video url'), 'failed');
});
