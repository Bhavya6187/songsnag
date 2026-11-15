import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { createTokenCipher } from '../src/crypto.ts';
import { openStore } from '../src/db.ts';
import { createSender, splitMessage } from '../src/instagram/send.ts';
import { parseWebhook } from '../src/instagram/webhook.ts';
import { createPipeline, formatReply, REPLIES } from '../src/pipeline.ts';
import type { Recognition } from '../src/recognize/reel.ts';
import { createSpotify } from '../src/spotify/client.ts';
import { fakeFetch, fakeSpotifyApi, instagramFixture, json, recordingLogger, sign, type CatalogTrack } from './helpers.ts';

const SECRET = 'test-app-secret';
const IGSID = '1234567890123456';
const BASE_URL = 'https://api.songsnag.test';

const KHUSHI = { uri: 'spotify:track:khushi', name: 'Khushi', artists: ['Nazia Hassan', 'Zoheb Hassan'] };
const DISCO = { uri: 'spotify:track:disco', name: 'Disco Deewane', artists: ['Nazia Hassan'] };
const OTHER_KHUSHI = { uri: 'spotify:track:other', name: 'Khushi', artists: ['Someone Else'] };

const song = (title: string, artist: string | null) => ({
  title,
  artist,
  sources: ['caption' as const],
  confidence: 'high' as const,
});
const recognised = (...songs: ReturnType<typeof song>[]): Recognition => ({
  ok: true,
  songs,
  used: { caption: true, frames: 3, transcript: false },
  notes: [],
});

function setup(options: { catalog?: CatalogTrack[]; playlist?: string[]; recognition?: Recognition; linked?: boolean } = {}) {
  const clock = { now: 1_800_000_000_000 };
  const now = () => clock.now;
  const log = recordingLogger();
  const store = openStore(':memory:', createTokenCipher(randomBytes(32)), now);
  const api = fakeSpotifyApi({ catalog: options.catalog ?? [KHUSHI, DISCO, OTHER_KHUSHI], playlist: options.playlist });
  const spotify = createSpotify({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: `${BASE_URL}/auth/spotify/callback`,
    fetch: api.fetch,
  });

  const sent: { igsid: string; text: string }[] = [];
  const recognition = { next: options.recognition ?? recognised(song('Khushi', 'Nazia Hassan')), calls: [] as unknown[] };
  const pipeline = createPipeline({
    store,
    spotify,
    log,
    now,
    baseUrl: BASE_URL,
    send: async (igsid, text) => {
      sent.push({ igsid, text });
      return { ok: true };
    },
    recognize: async (input) => {
      recognition.calls.push(input);
      return recognition.next;
    },
  });

  if (options.linked !== false) {
    store.saveUser({
      igsid: IGSID,
      spotifyUserId: 'spotify-user-1',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessExpiresAt: clock.now + 3_600_000,
      playlistId: 'playlist-1',
    });
  }

  const app = createApp({
    log,
    config: { metaAppSecret: SECRET, metaVerifyToken: 'v', captureDir: null, igHandle: null, contactEmail: null },
    service: { store, spotify, pipeline, now },
  });
  /** Delivers a webhook body the way Meta does and waits for the background work. */
  const deliver = async (body: string) => {
    const response = await app.request('/webhook/instagram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, SECRET) },
      body,
    });
    assert.equal(response.status, 200);
    await pipeline.idle();
  };
  const linkFrom = (text: string) => text.match(/https:\/\/api\.songsnag\.test\/link\/(\S+)/)?.[1] ?? null;
  return { app, api, store, pipeline, sent, recognition, log, clock, deliver, linkFrom };
}

const REEL = instagramFixture('recorded-reel');
const REEL_MID = 'MID_RECORDED_REEL';

test('a reel from a linked person: the song is found, added, and reported by its Spotify name', async () => {
  const { api, store, sent, recognition, deliver } = setup();
  await deliver(REEL);

  assert.deepEqual(recognition.calls, [
    { url: 'https://www.instagram.com/reel/SHORTCODE01/', caption: 'Example caption #tag' },
  ]);
  assert.deepEqual(api.state.playlist, ['spotify:track:khushi']);
  assert.deepEqual(sent, [{ igsid: IGSID, text: 'Snagged: Khushi by Nazia Hassan, Zoheb Hassan' }]);
  assert.equal(store.getReel(REEL_MID)?.status, 'done');
});

test('a retried delivery of the same message does nothing the second time', async () => {
  const { api, sent, recognition, deliver, log } = setup();
  await deliver(REEL);
  await deliver(REEL);
  assert.equal(recognition.calls.length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(api.state.playlist, ['spotify:track:khushi']);
  assert.equal(log.records.some((record) => record.msg === 'duplicate delivery skipped'), true);
});

test('the webhook is acknowledged before the reel is processed', async () => {
  const { app, pipeline, sent } = setup();
  const response = await app.request('/webhook/instagram', {
    method: 'POST',
    headers: { 'x-hub-signature-256': sign(REEL, SECRET) },
    body: REEL,
  });
  assert.equal(await response.text(), 'EVENT_RECEIVED');
  assert.equal(sent.length, 0);
  await pipeline.idle();
  assert.equal(sent.length, 1);
});

test('several songs: new ones are added in one request, known and missing ones are listed', async () => {
  const { api, sent, deliver } = setup({
    playlist: ['spotify:track:disco'],
    recognition: recognised(
      song('Khushi', 'Nazia Hassan'),
      song('Disco Deewane', 'Nazia Hassan'),
      song('A Song Nobody Released', 'Nobody'),
      song('Khushi', 'Zoheb Hassan'),
    ),
  });
  await deliver(REEL);

  assert.deepEqual(api.state.playlist, ['spotify:track:disco', 'spotify:track:khushi']);
  assert.equal(api.requests.filter((request) => request.method === 'POST' && request.url.pathname.endsWith('/items')).length, 1);
  assert.equal(
    sent[0]?.text,
    [
      'Snagged 1 song:\n• Khushi by Nazia Hassan, Zoheb Hassan',
      'Already in your playlist:\n• Disco Deewane by Nazia Hassan\n• Khushi by Nazia Hassan, Zoheb Hassan',
      "Couldn't find on Spotify:\n• A Song Nobody Released by Nobody",
    ].join('\n\n'),
  );
});

test('a search result by a different artist is not added', async () => {
  const { api, sent, deliver } = setup({ catalog: [OTHER_KHUSHI] });
  await deliver(REEL);
  assert.deepEqual(api.state.playlist, []);
  assert.equal(sent[0]?.text, "Couldn't find on Spotify:\n• Khushi by Nazia Hassan");
});

test('a song with no artist is added on an exact title and flagged in the reply', async () => {
  const { api, sent, deliver } = setup({ recognition: recognised(song('Disco Deewane', null)) });
  await deliver(REEL);
  assert.deepEqual(api.state.playlist, ['spotify:track:disco']);
  assert.equal(sent[0]?.text, 'Snagged: Disco Deewane by Nazia Hassan (the reel gave no artist, so check this one)');
});

test('a reel that names no song gets a plain explanation and touches nothing', async () => {
  const { api, sent, store, deliver } = setup({ recognition: recognised() });
  await deliver(REEL);
  assert.deepEqual(sent, [{ igsid: IGSID, text: REPLIES.noSongs }]);
  assert.deepEqual(api.state.playlist, []);
  assert.equal(store.getReel(REEL_MID)?.status, 'done');
});

test('each way recognition can fail gets its own short DM', async () => {
  const cases: [Recognition, string][] = [
    [{ ok: false, stage: 'download', reason: 'restricted', detail: 'login required' }, REPLIES.restricted],
    [{ ok: false, stage: 'download', reason: 'not-found', detail: '404' }, REPLIES.reelGone],
    [{ ok: false, stage: 'download', reason: 'blocked', detail: '429' }, REPLIES.reelFailed],
    [{ ok: false, stage: 'media', reason: 'failed', detail: 'ffmpeg' }, REPLIES.reelFailed],
    [{ ok: false, stage: 'extract', reason: 'api-error', detail: '500' }, REPLIES.reelFailed],
  ];
  for (const [recognition, text] of cases) {
    const { sent, store, deliver } = setup({ recognition });
    await deliver(REEL);
    assert.deepEqual(sent, [{ igsid: IGSID, text }]);
    assert.partialDeepStrictEqual(store.getReel(REEL_MID), { status: 'failed' });
    assert.match(store.getReel(REEL_MID)?.error ?? '', new RegExp(recognition.ok ? '' : recognition.reason));
  }
});

test('an expired access token is refreshed before use and the new one is stored', async () => {
  const { api, store, sent, clock, deliver } = setup();
  api.state.validAccessTokens.clear();
  clock.now += 3_600_000;
  await deliver(REEL);
  assert.equal(sent[0]?.text, 'Snagged: Khushi by Nazia Hassan, Zoheb Hassan');
  assert.partialDeepStrictEqual(store.getUser(IGSID), {
    accessToken: 'access-2',
    refreshToken: 'refresh-1',
    accessExpiresAt: clock.now + 3_600_000,
  });
});

test('an access token Spotify rejects early is refreshed once and the call repeated', async () => {
  const { api, sent, deliver } = setup();
  api.state.validAccessTokens.clear();
  await deliver(REEL);
  assert.equal(sent[0]?.text, 'Snagged: Khushi by Nazia Hassan, Zoheb Hassan');
  assert.deepEqual(api.state.playlist, ['spotify:track:khushi']);
});

test('a dead refresh token: the person gets a new link, and the reel is processed once they relink', async () => {
  const { app, api, store, sent, recognition, clock, deliver, pipeline, linkFrom } = setup();
  api.state.validAccessTokens.clear();
  api.state.refresh = { error: 'invalid_grant' };
  clock.now += 3_600_000;
  await deliver(REEL);

  assert.equal(recognition.calls.length, 0, 'the reel is not read while the link is dead');
  assert.equal(store.getUser(IGSID)?.needsRelink, true);
  assert.equal(store.getReel(REEL_MID)?.status, 'pending_link');
  const token = linkFrom(sent[0]!.text);
  assert.ok(token);
  assert.equal(sent[0]?.text, REPLIES.relink(`${BASE_URL}/link/${token}`));

  api.state.validAccessTokens.add('access-1');
  const callback = await app.request(`/auth/spotify/callback?code=good-code&state=${token}`);
  assert.equal(callback.status, 200);
  await pipeline.idle();

  assert.equal(api.state.createdPlaylists.length, 0, 'the same Spotify account keeps its playlist');
  assert.deepEqual(sent.slice(1).map((message) => message.text), [
    REPLIES.linked,
    'Snagged: Khushi by Nazia Hassan, Zoheb Hassan',
  ]);
  assert.equal(store.getUser(IGSID)?.needsRelink, false);
});

test('Spotify refusing or failing is reported without adding anything', async () => {
  for (const [status, text] of [[403, REPLIES.notInvited], [500, REPLIES.spotifyFailed]] as const) {
    const { api, sent, store, deliver } = setup();
    api.state.apiStatus = status;
    await deliver(REEL);
    assert.deepEqual(sent, [{ igsid: IGSID, text }], String(status));
    assert.equal(store.getReel(REEL_MID)?.status, 'failed');
  }
});

test('first reel from someone new: link, sign in, playlist created, the waiting reel processed', async () => {
  const { app, api, store, sent, recognition, deliver, pipeline, linkFrom } = setup({ linked: false });
  await deliver(REEL);

  assert.equal(recognition.calls.length, 0);
  assert.equal(store.getReel(REEL_MID)?.status, 'pending_link');
  const token = linkFrom(sent[0]!.text);
  assert.ok(token);
  assert.equal(sent[0]?.text, REPLIES.link(`${BASE_URL}/link/${token}`));

  // Opening the link (or a link preview fetching it) redirects to Spotify and does not use it up.
  for (let i = 0; i < 2; i += 1) {
    const link = await app.request(`/link/${token}`);
    assert.equal(link.status, 302);
    const location = new URL(link.headers.get('location')!);
    assert.equal(location.origin + location.pathname, 'https://accounts.spotify.com/authorize');
    assert.equal(location.searchParams.get('state'), token);
    assert.equal(location.searchParams.get('redirect_uri'), `${BASE_URL}/auth/spotify/callback`);
    assert.equal(link.headers.get('cache-control'), 'no-store');
  }

  const callback = await app.request(`/auth/spotify/callback?code=good-code&state=${token}`);
  assert.equal(callback.status, 200);
  assert.match(await callback.text(), /You’re linked/);
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  await pipeline.idle();

  assert.deepEqual(api.state.createdPlaylists, [
    { name: 'SongSnag', description: 'Songs from the reels you sent to SongSnag.', public: false },
  ]);
  assert.partialDeepStrictEqual(store.getUser(IGSID), {
    spotifyUserId: 'spotify-user-1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    playlistId: 'playlist-1',
  });
  assert.deepEqual(sent.slice(1).map((message) => message.text), [
    REPLIES.linked,
    'Snagged: Khushi by Nazia Hassan, Zoheb Hassan',
  ]);
  assert.deepEqual(api.state.playlist, ['spotify:track:khushi']);

  // The link is spent.
  assert.equal((await app.request(`/link/${token}`)).status, 410);
  const again = await app.request(`/auth/spotify/callback?code=good-code&state=${token}`);
  assert.equal(again.status, 410);
  assert.equal(api.state.createdPlaylists.length, 1);
});

test('linking with a different Spotify account creates a playlist in that account', async () => {
  const { app, api, store, pipeline } = setup();
  api.state.userId = 'spotify-user-2';
  const token = store.createLinkToken(IGSID, 60_000);
  await app.request(`/auth/spotify/callback?code=good-code&state=${token}`);
  await pipeline.idle();
  assert.equal(api.state.createdPlaylists.length, 1);
  assert.partialDeepStrictEqual(store.getUser(IGSID), { spotifyUserId: 'spotify-user-2', playlistId: 'playlist-1' });
});

test('links that are unknown, expired, declined or refused by Spotify each get their own page', async () => {
  const { app, api, store, clock, sent, pipeline } = setup({ linked: false });

  assert.equal((await app.request('/link/made-up')).status, 410);
  assert.equal((await app.request('/auth/spotify/callback?code=good-code&state=made-up')).status, 410);
  assert.equal((await app.request('/auth/spotify/callback?code=good-code')).status, 400);

  const token = store.createLinkToken(IGSID, 60_000);
  const declined = await app.request(`/auth/spotify/callback?error=access_denied&state=${token}`);
  assert.match(await declined.text(), /Not linked/);
  assert.equal(store.peekLinkToken(token), IGSID, 'declining does not use the link up');

  const badCode = await app.request(`/auth/spotify/callback?code=stale-code&state=${token}`);
  assert.equal(badCode.status, 502);
  assert.match(await badCode.text(), /Something went wrong/);
  assert.equal(store.peekLinkToken(token), IGSID, 'a failure on our side leaves the link usable');

  api.state.apiStatus = 403;
  const refused = await app.request(`/auth/spotify/callback?code=good-code&state=${token}`);
  assert.match(await refused.text(), /Spotify said no/);
  assert.equal(store.getUser(IGSID), null);
  assert.equal(store.peekLinkToken(token), IGSID);

  clock.now += 60_001;
  assert.equal((await app.request(`/link/${token}`)).status, 410);
  await pipeline.idle();
  assert.deepEqual(sent, []);
});

test('without the service, the linking routes do not exist', async () => {
  const app = createApp({
    log: recordingLogger(),
    config: { metaAppSecret: SECRET, metaVerifyToken: 'v', captureDir: null, igHandle: null, contactEmail: null },
  });
  assert.equal((await app.request('/link/anything')).status, 404);
  assert.equal((await app.request('/auth/spotify/callback?code=a&state=b')).status, 404);
});

test('an unsupported share is answered once with a request to resend', async () => {
  const { sent, deliver } = setup();
  await deliver(instagramFixture('doc-unsupported'));
  await deliver(instagramFixture('doc-unsupported'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.text, REPLIES.unsupported);
});

test('a shared post gets a hint; plain text, echoes and read receipts get nothing', async () => {
  const { sent, deliver } = setup();
  await deliver(instagramFixture('doc-post-share'));
  assert.deepEqual(sent.map((message) => message.text), [REPLIES.notAReel]);
  for (const fixture of ['doc-text', 'doc-echo', 'doc-read', 'doc-dashboard-test']) {
    const before = sent.length;
    await deliver(instagramFixture(fixture));
    assert.equal(sent.length, before, fixture);
  }
});

test('in a self conversation a reel is processed but nothing else is ever answered', async () => {
  const { pipeline, sent, store } = setup({ linked: false });
  const [reel] = parseWebhook(JSON.parse(instagramFixture('doc-self-reel'))).events;
  assert.equal(reel?.kind === 'reel' && reel.isSelf, true);
  pipeline.handle(reel!);
  await pipeline.idle();
  assert.equal(sent.length, 1, 'the link is sent for the reel');

  // The bot's own link message coming back as a self message with an attachment.
  pipeline.handle({ kind: 'message', mid: 'MID_SELF_ECHO', igsid: sent[0]!.igsid, accountId: null, timestamp: null, isSelf: true, text: 'x', attachmentTypes: ['fallback'] });
  pipeline.handle({ kind: 'unsupported', mid: 'MID_SELF_UNSUPPORTED', igsid: sent[0]!.igsid, accountId: null, timestamp: null, isSelf: true, reason: 'flagged_unsupported' });
  await pipeline.idle();
  assert.equal(sent.length, 1);
  assert.equal(store.getReel('MID_SELF_ECHO'), null);
});

test('after a restart, reels that were cut off are closed and their senders asked to resend', async () => {
  const { pipeline, store, sent, clock } = setup();
  store.claimMessage({ mid: 'RECENT', igsid: IGSID, url: 'u', caption: null, status: 'queued' });
  store.setReelStatus('RECENT', 'processing');
  clock.now += 24 * 3_600_000;
  store.claimMessage({ mid: 'NEW', igsid: 'IGSID2', url: 'u', caption: null, status: 'queued' });
  pipeline.recover();
  await pipeline.idle();

  assert.equal(store.getReel('RECENT')?.status, 'failed');
  assert.equal(store.getReel('NEW')?.status, 'failed');
  assert.deepEqual(sent, [{ igsid: 'IGSID2', text: REPLIES.interrupted }], 'the day-old reel is outside the reply window');
});

test('one failing job does not stop the next', async () => {
  const { pipeline, sent, recognition, deliver, log } = setup();
  const fine = recognition.next;
  recognition.next = undefined as unknown as Recognition;
  await deliver(REEL);
  assert.equal(log.records.some((record) => record.msg === 'background job failed'), true);

  recognition.next = fine;
  await deliver(REEL.replace('MID_RECORDED_REEL', 'MID_SECOND'));
  await pipeline.idle();
  assert.equal(sent.at(-1)?.text, 'Snagged: Khushi by Nazia Hassan, Zoheb Hassan');
});

test('the reply formats one song, and sections for several', () => {
  const added = { song: { title: 't', artist: 'a' }, result: 'added' as const, track: KHUSHI, artistUnconfirmed: false };
  assert.equal(formatReply([added]), 'Snagged: Khushi by Nazia Hassan, Zoheb Hassan');
  assert.equal(
    formatReply([added, { ...added, track: DISCO }]),
    'Snagged 2 songs:\n• Khushi by Nazia Hassan, Zoheb Hassan\n• Disco Deewane by Nazia Hassan',
  );
  assert.equal(
    formatReply([{ ...added, result: 'already' }]),
    'Already in your playlist:\n• Khushi by Nazia Hassan, Zoheb Hassan',
  );
  assert.equal(
    formatReply([{ song: { title: 'Lost', artist: null }, result: 'not-found' }]),
    "Couldn't find on Spotify:\n• Lost",
  );
});

test('a DM is posted to the account\'s messages endpoint with the token in a header', async () => {
  const fake = fakeFetch(() => json({ recipient_id: IGSID, message_id: 'm' }));
  const send = createSender({ accountId: '17841400000000001', accessToken: 'ig-token', fetch: fake.fetch });
  assert.deepEqual(await send(IGSID, 'Snagged: Khushi by Nazia Hassan'), { ok: true });

  const [request] = fake.requests;
  assert.equal(request?.method, 'POST');
  assert.equal(request?.url.href, 'https://graph.facebook.com/v27.0/17841400000000001/messages');
  assert.equal(request?.url.href.includes('ig-token'), false);
  assert.equal(request?.headers.get('authorization'), 'Bearer ig-token');
  assert.deepEqual(JSON.parse(request!.body), {
    recipient: { id: IGSID },
    message: { text: 'Snagged: Khushi by Nazia Hassan' },
  });
});

test('a failed send is reported, not thrown', async () => {
  const refused = createSender({
    accountId: '1',
    accessToken: 't',
    fetch: fakeFetch(() => json({ error: { message: 'outside the allowed window' } }, 400)).fetch,
  });
  assert.partialDeepStrictEqual(await refused(IGSID, 'hi'), { ok: false });
  const offline = createSender({
    accountId: '1',
    accessToken: 't',
    fetch: fakeFetch(() => {
      throw new TypeError('fetch failed');
    }).fetch,
  });
  assert.partialDeepStrictEqual(await offline(IGSID, 'hi'), { ok: false });
});

test('long replies are split under Meta\'s 1000-byte limit, between lines', async () => {
  const lines = Array.from({ length: 40 }, (_, index) => `• Song number ${index} by Añ artist with a long name`);
  const parts = splitMessage(lines.join('\n'));
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(Buffer.byteLength(part, 'utf8') <= 1000);
  assert.equal(parts.join('\n'), lines.join('\n'));

  const unbroken = splitMessage('é'.repeat(1200));
  assert.deepEqual(unbroken.map((part) => Buffer.byteLength(part, 'utf8')), [1000, 1000, 400]);
  assert.deepEqual(splitMessage('short'), ['short']);

  const fake = fakeFetch(() => json({}));
  await createSender({ accountId: '1', accessToken: 't', fetch: fake.fetch })(IGSID, lines.join('\n'));
  assert.equal(fake.requests.length, parts.length);
});
