import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { instagramFixture, recordingLogger, sign } from './helpers.ts';

const SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function setup(options: { captureDir?: string } = {}) {
  const log = recordingLogger();
  const app = createApp({
    log,
    config: {
      metaAppSecret: SECRET,
      metaVerifyToken: VERIFY_TOKEN,
      captureDir: options.captureDir ?? null,
      igHandle: null,
      contactEmail: null,
    },
  });
  const post = (body: string, headers: Record<string, string> = {}) =>
    app.request('/webhook/instagram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  const postSigned = (body: string) => post(body, { 'x-hub-signature-256': sign(body, SECRET) });
  return { app, log, post, postSigned };
}

test('GET handshake echoes the challenge when the verify token matches', async () => {
  const { app } = setup();
  const response = await app.request(
    `/webhook/instagram?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=${VERIFY_TOKEN}`,
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '1158201444');
});

test('GET handshake is refused for a wrong token, a wrong mode, or missing parameters', async () => {
  const { app } = setup();
  const queries = [
    'hub.mode=subscribe&hub.challenge=1&hub.verify_token=wrong',
    `hub.mode=unsubscribe&hub.challenge=1&hub.verify_token=${VERIFY_TOKEN}`,
    `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`,
    'hub.mode=subscribe&hub.challenge=1',
    '',
  ];
  for (const query of queries) {
    const response = await app.request(`/webhook/instagram?${query}`);
    assert.equal(response.status, 403, query);
    assert.notEqual(await response.text(), '1', query);
  }
});

test('POST without a signature is rejected and nothing is parsed', async () => {
  const { post, log } = setup();
  const response = await post(instagramFixture('doc-reel'));
  assert.equal(response.status, 401);
  assert.deepEqual(
    log.records.map((record) => [record.level, record.fields.reason]),
    [['warn', 'missing']],
  );
});

test('POST with a signature from the wrong secret is rejected', async () => {
  const { post, log } = setup();
  const body = instagramFixture('doc-reel');
  const response = await post(body, { 'x-hub-signature-256': sign(body, 'wrong-secret') });
  assert.equal(response.status, 401);
  assert.equal(log.records.some((record) => record.msg === 'reel received'), false);
});

test('POST of a signed reel is acknowledged and the parsed attachment is logged', async () => {
  const { postSigned, log } = setup();
  const response = await postSigned(instagramFixture('doc-reel'));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'EVENT_RECEIVED');

  const received = log.records.find((record) => record.msg === 'webhook received');
  assert.partialDeepStrictEqual(received?.fields, {
    object: 'instagram',
    events: 1,
    capturedTo: null,
  });

  const reel = log.records.find((record) => record.msg === 'reel received');
  assert.deepEqual(reel?.fields, {
    mid: 'MID_DOC_REEL',
    igsid: '1234567890123456',
    isSelf: false,
    attachmentType: 'ig_reel',
    title: 'Sunset drive ☀️ #roadtrip',
    videoId: '18139494541428835',
    url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835&signature=EXAMPLE',
  });
});

test('POST of an unsupported share is acknowledged and logged as a warning', async () => {
  const { postSigned, log } = setup();
  const response = await postSigned(instagramFixture('doc-unsupported'));
  assert.equal(response.status, 200);
  const warning = log.records.find((record) => record.msg === 'unsupported message received');
  assert.equal(warning?.level, 'warn');
  assert.equal(warning?.fields.reason, 'flagged_unsupported');
});

test('message text is not written to the log', async () => {
  const { postSigned, log } = setup();
  await postSigned(instagramFixture('doc-text'));
  const message = log.records.find((record) => record.msg === 'message received without a reel');
  assert.equal(message?.fields.hasText, true);
  assert.equal(JSON.stringify(log.records).includes('hello'), false);
});

test('a signed body that is not JSON gets a 400', async () => {
  const { postSigned } = setup();
  const response = await postSigned('not json');
  assert.equal(response.status, 400);
});

test('an oversized body is refused before any signature work', async () => {
  const { post, log } = setup();
  const response = await post('x'.repeat(1024 * 1024 + 1));
  assert.equal(response.status, 413);
  assert.deepEqual(log.records, []);
});

test('with a capture directory, verified bodies are saved byte for byte', async (t) => {
  const captureDir = await mkdtemp(join(tmpdir(), 'songsnag-capture-'));
  t.after(() => rm(captureDir, { recursive: true, force: true }));
  const { post, postSigned, log } = setup({ captureDir });
  const body = instagramFixture('doc-reel');

  // An unverified request must not be written to disk.
  await post(body);
  assert.deepEqual(await readdir(captureDir), []);

  await postSigned(body);
  const files = await readdir(captureDir);
  assert.equal(files.length, 1);
  const captured = await readFile(join(captureDir, files[0]!), 'utf8');
  assert.equal(captured, body);

  const received = log.records.find((record) => record.msg === 'webhook received');
  assert.equal(received?.fields.capturedTo, join(captureDir, files[0]!));
});
