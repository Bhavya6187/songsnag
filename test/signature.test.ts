import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifySignature } from '../src/instagram/signature.ts';
import { sign } from './helpers.ts';

const SECRET = 'app-secret';
const body = Buffer.from('{"object":"instagram","entry":[]}');

test('accepts a body signed with the app secret', () => {
  assert.deepEqual(verifySignature(body, sign(body, SECRET), SECRET), { ok: true });
});

test('accepts an upper-case hex digest', () => {
  const hex = sign(body, SECRET).slice('sha256='.length);
  assert.deepEqual(verifySignature(body, `sha256=${hex.toUpperCase()}`, SECRET), { ok: true });
});

test('rejects a request with no signature header', () => {
  assert.deepEqual(verifySignature(body, undefined, SECRET), { ok: false, reason: 'missing' });
  assert.deepEqual(verifySignature(body, '', SECRET), { ok: false, reason: 'missing' });
});

test('rejects a header that is not sha256=<64 hex chars>', () => {
  for (const header of ['sha1=abcdef', 'sha256=abc', 'sha256=' + 'z'.repeat(64), 'a'.repeat(64)]) {
    assert.deepEqual(
      verifySignature(body, header, SECRET),
      { ok: false, reason: 'malformed' },
      header,
    );
  }
});

test('rejects a signature made with a different secret', () => {
  const result = verifySignature(body, sign(body, 'someone-elses-secret'), SECRET);
  assert.deepEqual(result, { ok: false, reason: 'mismatch' });
});

test('rejects a body that was altered after signing', () => {
  const header = sign(body, SECRET);
  const altered = Buffer.from('{"object":"instagram","entry":[{}]}');
  assert.deepEqual(verifySignature(altered, header, SECRET), { ok: false, reason: 'mismatch' });
});

test('verifies the bytes as sent, not a re-serialized copy', () => {
  // Meta escapes non-ASCII characters and slashes in the body it signs.
  const sent = String.raw`{"title":"café","url":"https:\/\/example.com\/a"}`;
  const header = sign(sent, SECRET);

  assert.equal(verifySignature(Buffer.from(sent), header, SECRET).ok, true);

  const reserialized = JSON.stringify(JSON.parse(sent));
  assert.notEqual(reserialized, sent);
  assert.equal(verifySignature(Buffer.from(reserialized), header, SECRET).ok, false);
});
