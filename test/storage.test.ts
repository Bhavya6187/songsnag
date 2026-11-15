import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { loadConfig, ConfigError } from '../src/config.ts';
import { createTokenCipher, parseEncryptionKey } from '../src/crypto.ts';
import { openStore } from '../src/db.ts';

const KEY = randomBytes(32);

function setup() {
  const clock = { now: 1_800_000_000_000 };
  const store = openStore(':memory:', createTokenCipher(KEY), () => clock.now);
  return { store, clock };
}

const USER = {
  igsid: 'IGSID1',
  spotifyUserId: 'spotify-user-1',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  accessExpiresAt: 1_800_000_360_000,
  playlistId: 'playlist-1',
};

test('a sealed value opens with the same key and not with another or after tampering', () => {
  const cipher = createTokenCipher(KEY);
  const sealed = cipher.encrypt('refresh-secret');
  assert.equal(sealed.includes('refresh-secret'), false);
  assert.notEqual(sealed, cipher.encrypt('refresh-secret'), 'each value gets its own nonce');
  assert.equal(cipher.decrypt(sealed), 'refresh-secret');
  assert.throws(() => createTokenCipher(randomBytes(32)).decrypt(sealed));
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => cipher.decrypt(parts.join('.')));
});

test('an encryption key must be 32 bytes of base64', () => {
  assert.equal(parseEncryptionKey(KEY.toString('base64'))?.equals(KEY), true);
  assert.equal(parseEncryptionKey('short'), null);
  assert.equal(parseEncryptionKey(''), null);
});

test('tokens are stored encrypted and read back in the clear', (t) => {
  const { store } = setup();
  t.after(() => store.close());
  store.saveUser(USER);
  assert.deepEqual(store.getUser('IGSID1'), { ...USER, needsRelink: false });
  assert.equal(store.getUser('nobody'), null);
});

test('the database file never holds a token in the clear', async (t) => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'songsnag-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = openStore(join(dir, 'nested', 'songsnag.db'), createTokenCipher(KEY));
  store.saveUser(USER);
  store.close();
  const bytes = await readFile(join(dir, 'nested', 'songsnag.db'));
  assert.equal(bytes.includes('access-secret'), false);
  assert.equal(bytes.includes('refresh-secret'), false);
  assert.equal(bytes.includes('playlist-1'), true);
});

test('linking again replaces the tokens and clears the relink flag', (t) => {
  const { store } = setup();
  t.after(() => store.close());
  store.saveUser(USER);
  store.markNeedsRelink('IGSID1');
  assert.equal(store.getUser('IGSID1')?.needsRelink, true);
  store.saveUser({ ...USER, accessToken: 'new-access' });
  assert.partialDeepStrictEqual(store.getUser('IGSID1'), { accessToken: 'new-access', needsRelink: false });
});

test('a message is claimed once, so a retried delivery is recognised', (t) => {
  const { store } = setup();
  t.after(() => store.close());
  const message = { mid: 'MID1', igsid: 'IGSID1', url: 'https://www.instagram.com/reel/abcde/', caption: 'hi', status: 'queued' as const };
  assert.equal(store.claimMessage(message), true);
  assert.equal(store.claimMessage(message), false);
  store.setReelStatus('MID1', 'done', { matched: [{ a: 1 }] });
  assert.partialDeepStrictEqual(store.getReel('MID1'), { status: 'done', matched: '[{"a":1}]', error: null });
});

test('a link token works until it is used or expires, and is stored only as a hash', (t) => {
  const { store, clock } = setup();
  t.after(() => store.close());

  const token = store.createLinkToken('IGSID1', 60_000);
  assert.equal(store.peekLinkToken(token), 'IGSID1');
  assert.equal(store.peekLinkToken(token), 'IGSID1', 'peeking does not use it up');
  assert.equal(store.peekLinkToken('made-up'), null);
  assert.equal(store.consumeLinkToken(token), 'IGSID1');
  assert.equal(store.consumeLinkToken(token), null);
  assert.equal(store.peekLinkToken(token), null);
  store.restoreLinkToken(token);
  assert.equal(store.peekLinkToken(token), 'IGSID1');

  clock.now += 60_001;
  assert.equal(store.peekLinkToken(token), null);
  assert.equal(store.consumeLinkToken(token), null);
});

test('deleting a person removes their link, tokens and reels and nobody else\'s', (t) => {
  const { store } = setup();
  t.after(() => store.close());
  store.saveUser(USER);
  store.saveUser({ ...USER, igsid: 'IGSID2' });
  store.createLinkToken('IGSID1', 60_000);
  store.claimMessage({ mid: 'MID1', igsid: 'IGSID1', url: 'u', caption: null, status: 'queued' });
  store.claimMessage({ mid: 'MID2', igsid: 'IGSID2', url: 'u', caption: null, status: 'queued' });

  assert.deepEqual(store.deleteUser('IGSID1'), { users: 1, links: 1, reels: 1 });
  assert.equal(store.getUser('IGSID1'), null);
  assert.equal(store.getReel('MID1'), null);
  assert.notEqual(store.getUser('IGSID2'), null);
  assert.notEqual(store.getReel('MID2'), null);
});

const WEBHOOK_ENV = { META_APP_SECRET: 's', META_VERIFY_TOKEN: 'v' };
const SERVICE_ENV = {
  ...WEBHOOK_ENV,
  IG_ACCESS_TOKEN: 'ig-token',
  IG_ACCOUNT_ID: '17841400000000001',
  SPOTIFY_CLIENT_ID: 'client-id',
  SPOTIFY_CLIENT_SECRET: 'client-secret',
  BASE_URL: 'https://api.songsnag.com/',
  TOKEN_ENCRYPTION_KEY: KEY.toString('base64'),
  ANTHROPIC_API_KEY: 'anthropic-key',
};

test('the service is off, with the reason, until every service variable is set', () => {
  const config = loadConfig({ ...SERVICE_ENV, SPOTIFY_CLIENT_ID: '', SPOTIFY_CLIENT_SECRET: undefined });
  assert.equal(config.service, null);
  assert.deepEqual(config.serviceMissing, ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET']);
});

test('a complete environment turns the service on', () => {
  const config = loadConfig(SERVICE_ENV);
  assert.deepEqual(config.serviceMissing, []);
  assert.partialDeepStrictEqual(config.service, {
    baseUrl: 'https://api.songsnag.com',
    openaiApiKey: null,
    databasePath: 'data/songsnag.db',
  });
  assert.equal(config.service?.tokenEncryptionKey.equals(KEY), true);
});

test('a malformed key or base URL stops the server instead of switching the service off', () => {
  assert.throws(() => loadConfig({ ...SERVICE_ENV, TOKEN_ENCRYPTION_KEY: 'not-a-key' }), ConfigError);
  assert.throws(() => loadConfig({ ...SERVICE_ENV, BASE_URL: 'api.songsnag.com' }), ConfigError);
  assert.throws(() => loadConfig({ ...SERVICE_ENV, BASE_URL: 'https://api.songsnag.com/app' }), ConfigError);
});
