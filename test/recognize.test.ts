import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { recognizeReel } from '../src/recognize/reel.ts';
import { buildContent, extractSongs, type Song } from '../src/recognize/songs.ts';
import { transcribe } from '../src/recognize/transcribe.ts';
import { extractFrames, frameInterval, MediaError, probeVideo, type RunTool } from '../src/reel/media.ts';

// --- media ---------------------------------------------------------------

test('frames are taken once a second, or spread evenly over a long reel', () => {
  assert.equal(frameInterval(16), 1);
  assert.equal(frameInterval(30), 1);
  assert.equal(frameInterval(90), 3);
});

test('extractFrames asks ffmpeg for a bounded number of frames and reports their times', async () => {
  const calls: string[][] = [];
  const run: RunTool = async (_tool, args) => {
    calls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const short = await extractFrames('/v/reel.mp4', '/work', 16.2, run);
  assert.equal(short.length, 17);
  assert.deepEqual(short[3], { path: '/work/frame-004.jpg', atSeconds: 3 });

  const long = await extractFrames('/v/reel.mp4', '/work', 90, run);
  assert.equal(long.length, 30);
  assert.equal(long[29]!.atSeconds, 87);
  assert.equal(calls[1]![calls[1]!.indexOf('-frames:v') + 1], '30');
});

test('probeVideo reads duration and audio presence, and fails clearly on junk', async () => {
  const ok: RunTool = async (_tool, args) =>
    args.includes('format=duration')
      ? { exitCode: 0, stdout: '16.252\n', stderr: '' }
      : { exitCode: 0, stdout: 'audio\n', stderr: '' };
  assert.deepEqual(await probeVideo('/v/reel.mp4', ok), { durationSeconds: 16.252, hasAudio: true });

  const bad: RunTool = async () => ({ exitCode: 1, stdout: '', stderr: 'Invalid data found' });
  await assert.rejects(probeVideo('/v/reel.mp4', bad), MediaError);
});

// --- transcription -------------------------------------------------------

async function withAudioFile(body: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'songsnag-test-'));
  try {
    const path = join(dir, 'audio.mp3');
    await writeFile(path, 'not-really-audio');
    await body(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('transcribe posts the audio and returns the text', async () => {
  await withAudioFile(async (path) => {
    let seen: { url: string; auth: string | null; model: unknown; hasFile: boolean } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData;
      seen = {
        url: String(url),
        auth: new Headers(init!.headers).get('authorization'),
        model: form.get('model'),
        hasFile: form.get('file') instanceof Blob,
      };
      return Response.json({ text: '  first up is Jiya Jale by Whoja Vu  ' });
    }) as typeof fetch;
    const result = await transcribe(path, { apiKey: 'test-key', fetchImpl });
    assert.deepEqual(result, { ok: true, text: 'first up is Jiya Jale by Whoja Vu' });
    assert.deepEqual(seen, {
      url: 'https://api.openai.com/v1/audio/transcriptions',
      auth: 'Bearer test-key',
      model: 'gpt-transcribe',
      hasFile: true,
    });
  });
});

test('transcribe reports API and network failures instead of throwing', async () => {
  await withAudioFile(async (path) => {
    const denied = (async () =>
      Response.json({ error: { message: 'Incorrect API key' } }, { status: 401 })) as typeof fetch;
    assert.deepEqual(await transcribe(path, { apiKey: 'k', fetchImpl: denied }), {
      ok: false,
      detail: 'HTTP 401: Incorrect API key',
    });
    const down = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    assert.deepEqual(await transcribe(path, { apiKey: 'k', fetchImpl: down }), {
      ok: false,
      detail: 'network down',
    });
  });
});

// --- song extraction -----------------------------------------------------

test('buildContent sends caption and transcript as text and each frame as a labelled image', () => {
  const content = buildContent({
    caption: 'song list:\n- jiya jale by whoja vu',
    transcript: null,
    frames: [
      { jpeg: Buffer.from('a'), atSeconds: 0 },
      { jpeg: Buffer.from('b'), atSeconds: 65 },
    ],
  });
  assert.deepEqual(content.map((block) => block.type), ['text', 'text', 'image', 'text', 'image', 'text']);
  const first = content[0]!;
  assert.ok(first.type === 'text' && first.text.includes('jiya jale by whoja vu'));
  assert.ok(first.type === 'text' && first.text.includes('(no transcript is available)'));
  const label = content[3]!;
  assert.ok(label.type === 'text' && label.text === 'Frame at about 1:05:');
  const image = content[4]!;
  assert.ok(image.type === 'image' && image.source.type === 'base64' && image.source.data === 'Yg==');
});

function fakeClient(reply: object | Error): { client: Anthropic; calls: unknown[] } {
  const calls: unknown[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: unknown) => {
          calls.push(params);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const SONG: Song = { title: 'Jiya Jale', artist: 'Whoja Vu', sources: ['caption', 'screen'], confidence: 'high' };

test('extractSongs returns the parsed list, trimmed and without repeats', async () => {
  const { client, calls } = fakeClient({
    stop_reason: 'end_turn',
    model: 'claude-opus-5-5',
    usage: { input_tokens: 100, output_tokens: 20 },
    parsed_output: {
      songs: [
        { ...SONG, title: ' Jiya Jale ' },
        { ...SONG, title: 'jiya jale', artist: 'whoja vu' },
        { ...SONG, title: '  ' },
        { title: 'Jija', artist: null, sources: ['speech'], confidence: 'medium' },
      ],
    },
  });
  const result = await extractSongs({ caption: 'x', transcript: null, frames: [] }, client);
  assert.deepEqual(result, {
    ok: true,
    songs: [SONG, { title: 'Jija', artist: null, sources: ['speech'], confidence: 'medium' }],
    usage: { inputTokens: 100, outputTokens: 20, model: 'claude-opus-5-5' },
  });
  assert.equal(calls.length, 1);
});

test('extractSongs makes no API call when there is nothing to read', async () => {
  const { client, calls } = fakeClient({});
  assert.deepEqual(await extractSongs({ caption: '  ', transcript: null, frames: [] }, client), {
    ok: true,
    songs: [],
  });
  assert.equal(calls.length, 0);
});

test('extractSongs reports a refusal, a cut-off answer and an unparsed answer', async () => {
  const cases = [
    [{ stop_reason: 'refusal', stop_details: { explanation: 'declined' }, parsed_output: null }, 'refused'],
    [{ stop_reason: 'max_tokens', parsed_output: null }, 'truncated'],
    [{ stop_reason: 'end_turn', parsed_output: null }, 'bad-output'],
  ] as const;
  for (const [reply, reason] of cases) {
    const result = await extractSongs({ caption: 'x', transcript: null, frames: [] }, fakeClient(reply).client);
    assert.equal(!result.ok && result.reason, reason);
  }
});

// --- whole pipeline ------------------------------------------------------

const URL_OK = 'https://www.instagram.com/reel/SHORTCODE01/';

function fakeSteps(overrides: Record<string, unknown> = {}) {
  const seen: { workDir?: string; evidence?: unknown } = {};
  const steps = {
    downloadReel: async (_url: string, options: { dir: string }) => {
      seen.workDir = options.dir;
      return { ok: true as const, path: join(options.dir, 'SHORTCODE01.mp4'), bytes: 10, shortcode: 'SHORTCODE01' };
    },
    probeVideo: async () => ({ durationSeconds: 2, hasAudio: true }),
    extractFrames: async (_video: string, dir: string) => {
      await writeFile(join(dir, 'frame-001.jpg'), 'one');
      // The second frame is never written, as happens at the end of some videos.
      return [
        { path: join(dir, 'frame-001.jpg'), atSeconds: 0 },
        { path: join(dir, 'frame-002.jpg'), atSeconds: 1 },
      ];
    },
    extractAudio: async (_video: string, dir: string) => join(dir, 'audio.mp3'),
    transcribe: async () => ({ ok: true as const, text: 'next is Jija' }),
    extractSongs: async (evidence: unknown) => {
      seen.evidence = evidence;
      return { ok: true as const, songs: [SONG] };
    },
    ...overrides,
  };
  return { steps, seen };
}

test('recognizeReel reads all three sources and deletes its working files', async () => {
  const { steps, seen } = fakeSteps();
  const result = await recognizeReel({ url: URL_OK, caption: 'song list' }, { openaiApiKey: 'k', steps });
  assert.deepEqual(result, {
    ok: true,
    songs: [SONG],
    used: { caption: true, frames: 1, transcript: true },
    notes: [],
  });
  const evidence = seen.evidence as { caption: string; transcript: string; frames: { atSeconds: number }[] };
  assert.equal(evidence.transcript, 'next is Jija');
  assert.equal(evidence.frames.length, 1);
  await assert.rejects(access(seen.workDir!));
  assert.equal(dirname(seen.workDir!), tmpdir().replace(/\/$/, ''));
});

test('recognizeReel carries on without speech when there is no key or transcription fails', async () => {
  const noKey = await recognizeReel({ url: URL_OK, caption: 'c' }, { openaiApiKey: null, steps: fakeSteps().steps });
  assert.ok(noKey.ok);
  assert.deepEqual(noKey.ok && noKey.notes, ['speech skipped: OPENAI_API_KEY is not set']);
  assert.equal(noKey.ok && noKey.used.transcript, false);

  const failing = fakeSteps({ transcribe: async () => ({ ok: false, detail: 'HTTP 500: oops' }) });
  const failed = await recognizeReel({ url: URL_OK, caption: 'c' }, { openaiApiKey: 'k', steps: failing.steps });
  assert.deepEqual(failed.ok && failed.notes, ['speech skipped: transcription failed (HTTP 500: oops)']);
});

test('recognizeReel reports which stage failed', async () => {
  const restricted = fakeSteps({
    downloadReel: async () => ({ ok: false, reason: 'restricted', detail: 'login needed' }),
  });
  assert.deepEqual(await recognizeReel({ url: URL_OK, caption: null }, { openaiApiKey: null, steps: restricted.steps }), {
    ok: false,
    stage: 'download',
    reason: 'restricted',
    detail: 'login needed',
  });

  const broken = fakeSteps({
    probeVideo: async () => {
      throw new MediaError('could not read the video');
    },
  });
  const media = await recognizeReel({ url: URL_OK, caption: null }, { openaiApiKey: null, steps: broken.steps });
  assert.equal(!media.ok && media.stage, 'media');

  const refused = fakeSteps({ extractSongs: async () => ({ ok: false, reason: 'auth', detail: 'bad key' }) });
  const extract = await recognizeReel({ url: URL_OK, caption: null }, { openaiApiKey: null, steps: refused.steps });
  assert.deepEqual(extract, { ok: false, stage: 'extract', reason: 'auth', detail: 'bad key' });
});
