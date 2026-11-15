import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { recordingLogger } from './helpers.ts';

function setup(site: { igHandle?: string | null; contactEmail?: string | null } = {}) {
  return createApp({
    log: recordingLogger(),
    config: {
      metaAppSecret: 'test-app-secret',
      metaVerifyToken: 'test-verify-token',
      captureDir: null,
      igHandle: site.igHandle ?? null,
      contactEmail: site.contactEmail ?? null,
    },
  });
}

const PAGES = {
  '/': 'Hear it in a reel',
  '/privacy': '<h1>Privacy Policy</h1>',
  '/terms': '<h1>Terms of Service</h1>',
  '/data-deletion': '<h1>Delete your data</h1>',
};

test('each public page is served as HTML and links to the legal pages', async () => {
  const app = setup();
  for (const [path, marker] of Object.entries(PAGES)) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', /^text\/html/, path);
    const html = await response.text();
    assert.ok(html.includes(marker), path);
    for (const link of ['/privacy', '/terms', '/data-deletion']) {
      assert.ok(html.includes(`href="${link}"`), `${path} links to ${link}`);
    }
  }
});

test('pages load nothing from other origins', async () => {
  const app = setup();
  for (const path of Object.keys(PAGES)) {
    const response = await app.request(path);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/, path);
    const html = await response.text();
    assert.doesNotMatch(html, /<script|<link[^>]+href="http|src="http/i, path);
  }
});

test('the handle and contact email come from config', async () => {
  const html = await (
    await setup({ igHandle: 'some.handle', contactEmail: 'privacy@example.com' }).request('/privacy')
  ).text();
  assert.ok(html.includes('https://www.instagram.com/some.handle/'));
  assert.ok(html.includes('@some.handle'));
  assert.ok(html.includes('mailto:privacy@example.com'));
});

test('without a handle or email the pages still say how to get in touch', async () => {
  for (const path of ['/privacy', '/terms', '/data-deletion']) {
    const html = await (await setup().request(path)).text();
    assert.ok(html.includes('send a message to the SongSnag account on Instagram'), path);
    assert.doesNotMatch(html, /mailto:|instagram\.com/, path);
  }
});

test('config values are HTML-escaped', async () => {
  const html = await (
    await setup({ igHandle: '"><b>x', contactEmail: '<i>@example.com' }).request('/privacy')
  ).text();
  assert.doesNotMatch(html, /<b>x|<i>@/);
});

test('unknown paths get a 404 page, and the webhook routes are unaffected', async () => {
  const app = setup();
  const missing = await app.request('/nope');
  assert.equal(missing.status, 404);
  assert.ok((await missing.text()).includes('Nothing here'));
  assert.equal((await app.request('/healthz')).status, 200);
  assert.equal((await app.request('/webhook/instagram')).status, 403);
  assert.equal((await app.request('/nope', { method: 'POST' })).status, 404);
});
