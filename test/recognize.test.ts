import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { fingerprintClips, fingerprintReel, identify, MAX_REQUESTS, type Fingerprint } from '../src/recognize/fingerprint.ts';
import { recognizeReel } from '../src/recognize/reel.ts';
import { buildContent, extractSongs, type Song } from '../src/recognize/songs.ts';
import { transcribe } from '../src/recognize/transcribe.ts';
import { extractFrames, frameInterval, MediaError, probeVideo, type RunTool } from '../src/reel/media.ts';
import { auddFixture } from './helpers.ts';

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

// --- fingerprinting ------------------------------------------------------

const TADKE = {
  title: 'Tadke Tadke',
  artist: 'Afterall',
  track: { uri: 'spotify:track:0ptmjtm7qOmGAz1ELQR5Rv', name: 'Tadke Tadke', artists: ['AFTERAll'] },
};
const JIYA = { title: 'Jiya Jale', artist: 'Whoja Vu', track: null };

/** An ffmpeg that writes a stand-in clip to the output path, and an AudD that answers from a list of fixtures. */
function fakeAudd(answers: (string | Error)[]) {
  const cuts: { start: number; length: number }[] = [];
  const run: RunTool = async (_tool, args) => {
    cuts.push({ start: Number(args[args.indexOf('-ss') + 1]), length: Number(args[args.indexOf('-t') + 1]) });
    await writeFile(args.at(-1)!, 'not-really-audio');
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const forms: FormData[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    forms.push(init!.body as FormData);
    const answer = answers[forms.length - 1] ?? 'recorded-no-match';
    if (answer instanceof Error) throw answer;
    return Response.json(auddFixture(answer));
  }) as typeof fetch;
  return { run, fetchImpl, cuts, forms, urls };
}

async function withWorkDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'songsnag-test-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const fingerprint = (durationSeconds: number, audd: ReturnType<typeof fakeAudd>) =>
  withWorkDir((dir) =>
    fingerprintReel('/v/reel.mp4', dir, durationSeconds, { apiKey: 'audd-key', fetchImpl: audd.fetchImpl, run: audd.run }),
  );

test('a reel is listened to in three clips at most, whatever its length', () => {
  for (const duration of [8, 16.2, 45, 120, 900]) {
    const clips = fingerprintClips(duration);
    assert.equal(clips.length, MAX_REQUESTS);
    for (const clip of clips) {
      assert.ok(clip.lengthSeconds <= 12 && clip.lengthSeconds > 0);
      assert.ok(clip.startSeconds >= 0 && clip.startSeconds + clip.lengthSeconds <= duration + 1e-9);
    }
  }
  // Each third of a 90-second reel, sampled around its middle.
  assert.deepEqual(fingerprintClips(90), [
    { startSeconds: 9, lengthSeconds: 12 },
    { startSeconds: 39, lengthSeconds: 12 },
    { startSeconds: 69, lengthSeconds: 12 },
  ]);
  // A short reel's thirds are sent whole.
  assert.deepEqual(fingerprintClips(15).map((clip) => clip.lengthSeconds), [5, 5, 5]);
});

test('a very short reel is one request with the whole audio', async () => {
  assert.deepEqual(fingerprintClips(6.5), [{ startSeconds: 0, lengthSeconds: 6.5 }]);
  const audd = fakeAudd(['recorded-match']);
  assert.deepEqual(await fingerprint(6.5, audd), { songs: [TADKE], requests: 1, failures: [] });
  assert.deepEqual(audd.cuts, [{ start: 0, length: 6.5 }]);
});

test('fingerprintReel posts each clip to AudD and returns the distinct songs', async () => {
  const audd = fakeAudd(['doc-match-no-spotify', 'recorded-match', 'recorded-match']);
  assert.deepEqual(await fingerprint(120, audd), { songs: [JIYA, TADKE], requests: 3, failures: [] });
  assert.deepEqual(audd.urls, Array(3).fill('https://api.audd.io/'));
  assert.equal(audd.forms[0]!.get('api_token'), 'audd-key');
  assert.equal(audd.forms[0]!.get('return'), 'spotify');
  assert.ok(audd.forms[0]!.get('file') instanceof Blob);
});

test('clips AudD does not know add nothing', async () => {
  const audd = fakeAudd([]);
  assert.deepEqual(await fingerprint(120, audd), { songs: [], requests: 3, failures: [] });
});

test('an AudD error on one clip is recorded and the other clips are still tried', async () => {
  const audd = fakeAudd(['doc-error-fingerprint', new Error('network down'), 'recorded-match']);
  const result = await fingerprint(60, audd);
  assert.deepEqual(result.songs, [TADKE]);
  assert.equal(result.requests, 3);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0]!, /^AudD error 300: /);
  assert.equal(result.failures[1], 'network down');
});

test('an error that would repeat, such as a used-up limit, stops after one request', async () => {
  const audd = fakeAudd(['doc-error-limit', 'recorded-match', 'recorded-match']);
  const result = await fingerprint(60, audd);
  assert.deepEqual(result.songs, []);
  assert.equal(result.requests, 1);
  assert.match(result.failures[0]!, /^AudD error 901: /);
});

test('a clip ffmpeg cannot cut costs no request', async () => {
  const audd = fakeAudd([]);
  const run: RunTool = async () => ({ exitCode: 1, stdout: '', stderr: 'Invalid data found' });
  const result = await withWorkDir((dir) =>
    fingerprintReel('/v/reel.mp4', dir, 6, { apiKey: 'k', fetchImpl: audd.fetchImpl, run }),
  );
  assert.deepEqual(result, { songs: [], requests: 0, failures: ['could not cut an audio clip: Invalid data found'] });
});

test('identify reports an answer that is not JSON instead of throwing', async () => {
  const fetchImpl = (async () => new Response('Bad gateway', { status: 502 })) as typeof fetch;
  assert.deepEqual(await identify(Buffer.from('x'), { apiKey: 'k', fetchImpl }), {
    ok: false,
    detail: 'HTTP 502: not a JSON answer',
    fatal: false,
  });
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
    fingerprintReel: async (): Promise<Fingerprint> => {
      throw new Error('fingerprinting was not expected to run');
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
    heard: [],
    used: { caption: true, frames: 1, transcript: true, fingerprint: 0 },
    notes: [],
    fingerprintFailed: false,
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

/** Steps for a reel that names nothing, with a fingerprint step that records its calls. */
function silentReel(fingerprint: Fingerprint | Error, overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const { steps } = fakeSteps({
    extractSongs: async () => ({ ok: true as const, songs: [] }),
    fingerprintReel: async (...args: unknown[]) => {
      calls.push(args);
      if (fingerprint instanceof Error) throw fingerprint;
      return fingerprint;
    },
    ...overrides,
  });
  return { steps, calls };
}

test('a reel that names no song is fingerprinted, and what is heard is returned apart from named songs', async () => {
  const { steps, calls } = silentReel({ songs: [TADKE], requests: 1, failures: [] });
  const result = await recognizeReel({ url: URL_OK, caption: 'c' }, { openaiApiKey: 'k', auddApiKey: 'audd-key', steps });
  assert.deepEqual(result, {
    ok: true,
    songs: [],
    heard: [TADKE],
    used: { caption: true, frames: 1, transcript: true, fingerprint: 1 },
    notes: [],
    fingerprintFailed: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![2], 2);
  assert.deepEqual(calls[0]![3], { apiKey: 'audd-key' });
});

test('a reel that names a song is never fingerprinted', async () => {
  // The default fake fingerprint step throws if it is called.
  const result = await recognizeReel(
    { url: URL_OK, caption: 'c' },
    { openaiApiKey: 'k', auddApiKey: 'audd-key', steps: fakeSteps().steps },
  );
  assert.deepEqual(result.ok && [result.songs, result.heard, result.used.fingerprint, result.notes], [[SONG], [], 0, []]);
});

test('without an AudD key, or without audio, nothing is fingerprinted', async () => {
  const noKey = silentReel({ songs: [TADKE], requests: 1, failures: [] });
  for (const auddApiKey of [null, undefined]) {
    const result = await recognizeReel({ url: URL_OK, caption: 'c' }, { openaiApiKey: 'k', auddApiKey, steps: noKey.steps });
    assert.deepEqual(result.ok && [result.heard, result.used.fingerprint, result.notes], [[], 0, []]);
  }
  assert.equal(noKey.calls.length, 0);

  const mute = silentReel(
    { songs: [TADKE], requests: 1, failures: [] },
    { probeVideo: async () => ({ durationSeconds: 2, hasAudio: false }) },
  );
  const result = await recognizeReel({ url: URL_OK, caption: 'c' }, { openaiApiKey: 'k', auddApiKey: 'a', steps: mute.steps });
  assert.deepEqual(result.ok && result.heard, []);
  assert.equal(mute.calls.length, 0);
});

test('a failed extraction is not papered over by fingerprinting', async () => {
  const { steps, calls } = silentReel(
    { songs: [TADKE], requests: 1, failures: [] },
    { extractSongs: async () => ({ ok: false, reason: 'api-error', detail: 'HTTP 529' }) },
  );
  const result = await recognizeReel({ url: URL_OK, caption: 'c' }, { openaiApiKey: 'k', auddApiKey: 'a', steps });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('an AudD failure is a note: the reel still ends with no songs', async () => {
  const failing = silentReel({ songs: [], requests: 1, failures: ['AudD error 901: limit reached'] });
  const failed = await recognizeReel({ url: URL_OK, caption: 'c' }, { openaiApiKey: 'k', auddApiKey: 'a', steps: failing.steps });
  assert.deepEqual(failed, {
    ok: true,
    songs: [],
    heard: [],
    used: { caption: true, frames: 1, transcript: true, fingerprint: 1 },
    notes: ['fingerprinting failed: AudD error 901: limit reached'],
    fingerprintFailed: true,
  });

  const throwing = silentReel(new Error('boom'));
  const thrown = await recognizeReel({ url: URL_OK, caption: 'c' }, { openaiApiKey: 'k', auddApiKey: 'a', steps: throwing.steps });
  assert.deepEqual(thrown.ok && [thrown.heard, thrown.notes, thrown.fingerprintFailed], [[], ['fingerprinting failed: boom'], true]);
});
