import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpotify, SCOPES } from '../src/spotify/client.ts';
import { artistMatches, pickTrack, searchQueries, titleScore } from '../src/spotify/match.ts';
import { fakeFetch, json, spotifyFixture } from './helpers.ts';

function client(respond: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(respond);
  const sleeps: number[] = [];
  const spotify = createSpotify({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://api.songsnag.com/auth/spotify/callback',
    fetch: fake.fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { spotify, requests: fake.requests, sleeps };
}

test('the authorize URL carries the client, the exact redirect URI, the scopes and the state', () => {
  const { spotify } = client(() => json({}));
  const url = new URL(spotify.authorizeUrl('STATE'));
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: 'client-id',
    response_type: 'code',
    redirect_uri: 'https://api.songsnag.com/auth/spotify/callback',
    scope: SCOPES.join(' '),
    state: 'STATE',
  });
});

test('a code is exchanged with basic auth and a form body', async () => {
  const { spotify, requests } = client(() =>
    json({ access_token: 'A', token_type: 'Bearer', expires_in: 3600, refresh_token: 'R', scope: '' }),
  );
  const result = await spotify.exchangeCode('CODE');
  assert.deepEqual(result, { ok: true, tokens: { accessToken: 'A', refreshToken: 'R', expiresInSeconds: 3600 } });

  const [request] = requests;
  assert.equal(request?.method, 'POST');
  assert.equal(request?.url.href, 'https://accounts.spotify.com/api/token');
  assert.equal(request?.headers.get('authorization'), `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
  assert.equal(request?.headers.get('content-type'), 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(request?.body)), {
    grant_type: 'authorization_code',
    code: 'CODE',
    redirect_uri: 'https://api.songsnag.com/auth/spotify/callback',
  });
});

test('a refresh that returns no new refresh token keeps that field null', async () => {
  const { spotify, requests } = client(() => json({ access_token: 'A2', expires_in: 3600 }));
  const result = await spotify.refresh('R');
  assert.deepEqual(result, { ok: true, tokens: { accessToken: 'A2', refreshToken: null, expiresInSeconds: 3600 } });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0]?.body)), {
    grant_type: 'refresh_token',
    refresh_token: 'R',
  });
});

test('a refused refresh token is told apart from an outage', async () => {
  const refused = client(() => json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400));
  assert.partialDeepStrictEqual(await refused.spotify.refresh('R'), { ok: false, reason: 'invalid-grant' });

  const down = client(() => new Response('upstream error', { status: 503 }));
  assert.partialDeepStrictEqual(await down.spotify.refresh('R'), { ok: false, reason: 'failed' });

  const offline = client(() => {
    throw new TypeError('fetch failed');
  });
  assert.partialDeepStrictEqual(await offline.spotify.refresh('R'), { ok: false, reason: 'failed' });
});

test('a playlist is created private through POST /me/playlists', async () => {
  const { spotify, requests } = client(() => json({ id: 'PLAYLIST1' }, 201));
  const result = await spotify.createPlaylist('A', { name: 'SongSnag', description: 'd' });
  assert.deepEqual(result, { ok: true, value: 'PLAYLIST1' });
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[0]?.url.href, 'https://api.spotify.com/v1/me/playlists');
  assert.equal(requests[0]?.headers.get('authorization'), 'Bearer A');
  assert.deepEqual(JSON.parse(requests[0]!.body), { name: 'SongSnag', description: 'd', public: false });
});

test('search asks for ten tracks and reads tracks from the documented response', async () => {
  const { spotify, requests } = client(() => json(spotifyFixture('doc-search-tracks')));
  const result = await spotify.searchTracks('A', 'Khushi Nazia Hassan');
  assert.deepEqual(result, {
    ok: true,
    value: [
      { uri: 'spotify:track:TRACK0000000000000001', name: 'Khushi', artists: ['Nazia Hassan', 'Zoheb Hassan'] },
      { uri: 'spotify:track:TRACK0000000000000002', name: 'Khushi (From "A Film")', artists: ['Someone Else'] },
    ],
  });
  assert.equal(requests[0]?.url.pathname, '/v1/search');
  assert.deepEqual(Object.fromEntries(requests[0]!.url.searchParams), {
    q: 'Khushi Nazia Hassan',
    type: 'track',
    limit: '10',
  });
});

test('playlist contents are read from /items, page by page, with the track under `item`', async () => {
  const { spotify, requests } = client(({ url }) =>
    url.searchParams.get('offset') === '0'
      ? json({ next: 'https://api.spotify.com/v1/more', items: [{ item: { uri: 'spotify:track:A' } }] })
      : json(spotifyFixture('doc-playlist-items')),
  );
  const result = await spotify.playlistUris('A', 'PLAYLIST1');
  assert.equal(result.ok, true);
  assert.deepEqual([...(result.ok ? result.value : [])], [
    'spotify:track:A',
    'spotify:track:TRACK0000000000000001',
    'spotify:track:TRACK0000000000000009',
  ]);
  assert.deepEqual(
    requests.map((request) => `${request.url.pathname}?offset=${request.url.searchParams.get('offset')}`),
    ['/v1/playlists/PLAYLIST1/items?offset=0', '/v1/playlists/PLAYLIST1/items?offset=50'],
  );
});

test('tracks are added through POST /playlists/{id}/items with the URIs in the body', async () => {
  const { spotify, requests } = client(() => json({ snapshot_id: 'abc' }, 201));
  const result = await spotify.addToPlaylist('A', 'PLAYLIST1', ['spotify:track:A', 'spotify:track:B']);
  assert.deepEqual(result, { ok: true, value: null });
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[0]?.url.href, 'https://api.spotify.com/v1/playlists/PLAYLIST1/items');
  assert.deepEqual(JSON.parse(requests[0]!.body), { uris: ['spotify:track:A', 'spotify:track:B'] });
});

test('API failures are classified by status', async () => {
  for (const [status, reason] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [500, 'failed']] as const) {
    const { spotify } = client(() => json({ error: { status, message: 'nope' } }, status));
    assert.partialDeepStrictEqual(await spotify.currentUserId('A'), { ok: false, reason }, String(status));
  }
});

test('a short rate limit is waited out once; a long one is reported', async () => {
  let calls = 0;
  const short = client(() => (calls++ === 0 ? json({}, 429, { 'retry-after': '2' }) : json({ id: 'me' })));
  assert.deepEqual(await short.spotify.currentUserId('A'), { ok: true, value: 'me' });
  assert.deepEqual(short.sleeps, [2000]);

  const long = client(() => json({}, 429, { 'retry-after': '3600' }));
  assert.partialDeepStrictEqual(await long.spotify.currentUserId('A'), { ok: false, reason: 'rate-limited' });
  assert.equal(long.requests.length, 1);
});

const track = (name: string, ...artists: string[]) => ({ uri: `spotify:track:${name}`, name, artists });

test('titles match through decorations, accents and small misspellings, not through different words', () => {
  assert.equal(titleScore('Khushi', 'Khushi'), 3);
  assert.equal(titleScore('Blinding Lights (Remix)', 'Blinding Lights - Remix'), 3);
  assert.equal(titleScore('Khushi', 'Khushi (From "Young Tarang")'), 2);
  assert.equal(titleScore('Beyoncé', 'Beyonce - Remastered 2011'), 2);
  assert.equal(titleScore('Stay', 'Stay (feat. Justin Bieber)'), 2);
  assert.equal(titleScore('Khushee Khushi', 'Khushi Khushi'), 1);
  assert.equal(titleScore('Stay', 'Stay With Me'), 0);
  assert.equal(titleScore('Boom Boom', 'Khushi'), 0);
  assert.equal(titleScore('तुम ही हो', 'तुम ही हो'), 3);
});

test('an artist matches when any credited name does', () => {
  assert.equal(artistMatches('Nazia Hassan, Zoheb Hassan', ['Zoheb Hassan']), true);
  assert.equal(artistMatches('The Kid LAROI & Justin Bieber', ['The Kid LAROI', 'Justin Bieber']), true);
  assert.equal(artistMatches('Florence and the Machine', ['Florence + The Machine']), true);
  assert.equal(artistMatches('Beyonce', ['Beyoncé']), true);
  assert.equal(artistMatches('Weeknd', ['The Weeknd']), true);
  assert.equal(artistMatches('Nazia Hassan', ['Someone Else']), false);
  assert.equal(artistMatches('Ed', ['Ed Sheeran']), false, 'too short to mean anything');
});

test('with an artist, the track must agree on title and artist', () => {
  const song = { title: 'Khushi', artist: 'Nazia Hassan' };
  const wrongArtist = track('Khushi', 'Someone Else');
  const right = track('Khushi (From "Young Tarang")', 'Nazia Hassan', 'Zoheb Hassan');
  assert.deepEqual(pickTrack(song, [wrongArtist, right]), { found: true, track: right, artistUnconfirmed: false });
  assert.deepEqual(pickTrack(song, [wrongArtist]), { found: false });
  assert.deepEqual(pickTrack(song, [track('Boom Boom', 'Nazia Hassan')]), { found: false });
  assert.deepEqual(pickTrack(song, []), { found: false });
});

test('the closest title wins, and Spotify\'s order breaks ties', () => {
  const song = { title: 'Stay (Live)', artist: 'Rihanna' };
  const studio = track('Stay', 'Rihanna');
  const live = { ...track('Stay - Live', 'Rihanna'), uri: 'spotify:track:live' };
  assert.partialDeepStrictEqual(pickTrack(song, [studio, live]), { track: live });
  const first = { ...track('Stay', 'Rihanna'), uri: 'spotify:track:first' };
  assert.partialDeepStrictEqual(pickTrack({ title: 'Stay', artist: 'Rihanna' }, [first, studio]), { track: first });
});

test('without an artist, only an exact title is accepted and it is marked unconfirmed', () => {
  const song = { title: 'Khushi', artist: null };
  const exact = track('Khushi', 'Nazia Hassan');
  assert.deepEqual(pickTrack(song, [track('Khushi Khushi', 'X'), exact]), {
    found: true,
    track: exact,
    artistUnconfirmed: true,
  });
  assert.deepEqual(pickTrack({ title: 'Khushee Khushi', artist: null }, [track('Khushi Khushi', 'X')]), { found: false });
});

test('search tries plain words first, then field filters', () => {
  assert.deepEqual(searchQueries({ title: 'Khushi', artist: 'Nazia Hassan' }), [
    'Khushi Nazia Hassan',
    'track:Khushi artist:Nazia Hassan',
  ]);
  assert.deepEqual(searchQueries({ title: 'Khushi', artist: null }), ['Khushi']);
});
