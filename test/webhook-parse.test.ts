import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJsonKeepingBigIntegers, parseWebhook } from '../src/instagram/webhook.ts';
import { instagramFixture } from './helpers.ts';

const ACCOUNT_ID = '17841400000000001';
const SENDER_ID = '1234567890123456';

function parseFixture(name: string) {
  return parseWebhook(parseJsonKeepingBigIntegers(instagramFixture(name)));
}

test('parses a shared reel into its URL, caption and video ID', () => {
  assert.deepEqual(parseFixture('doc-reel'), {
    object: 'instagram',
    events: [
      {
        kind: 'reel',
        accountId: ACCOUNT_ID,
        igsid: SENDER_ID,
        mid: 'MID_DOC_REEL',
        timestamp: 1761287294014,
        isSelf: false,
        reel: {
          attachmentType: 'ig_reel',
          url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=18139494541428835&signature=EXAMPLE',
          title: 'Sunset drive ☀️ #roadtrip',
          // Sent as a bare JSON number that a plain JSON.parse would round to ...836.
          videoId: '18139494541428835',
        },
      },
    ],
  });
});

test('parses a recorded reel share, where the URL is the reel permalink', () => {
  // Recorded 2026-11-14 from a Unified Login app, then redacted. Unlike the
  // documented shape, `url` is the public reel page rather than a video file,
  // and `reel_video_id` is a string.
  const { events } = parseFixture('recorded-reel');
  assert.equal(events.length, 1);
  assert.partialDeepStrictEqual(events[0], {
    kind: 'reel',
    accountId: ACCOUNT_ID,
    igsid: SENDER_ID,
    mid: 'MID_RECORDED_REEL',
    isSelf: false,
    reel: {
      attachmentType: 'ig_reel',
      url: 'https://www.instagram.com/reel/SHORTCODE01/',
      title: 'Example caption #tag',
      videoId: '18000000000000001',
    },
  });
});

test('treats a reel attachment with no URL as unsupported', () => {
  const { events } = parseFixture('doc-reel-no-url');
  assert.equal(events.length, 1);
  assert.partialDeepStrictEqual(events[0], {
    kind: 'unsupported',
    reason: 'reel_without_url',
    mid: 'MID_DOC_REEL_NO_URL',
    igsid: SENDER_ID,
  });
});

test('treats a message flagged is_unsupported as unsupported', () => {
  const { events } = parseFixture('doc-unsupported');
  assert.equal(events.length, 1);
  assert.partialDeepStrictEqual(events[0], {
    kind: 'unsupported',
    reason: 'flagged_unsupported',
    mid: 'MID_DOC_UNSUPPORTED',
    igsid: SENDER_ID,
  });
});

test('parses a text message as a message without attachments', () => {
  const { events } = parseFixture('doc-text');
  assert.deepEqual(events, [
    {
      kind: 'message',
      accountId: ACCOUNT_ID,
      igsid: SENDER_ID,
      mid: 'MID_DOC_TEXT',
      timestamp: 1761287294014,
      isSelf: false,
      text: 'hello',
      attachmentTypes: [],
    },
  ]);
});

test('reports the attachment types of a share that is not a reel', () => {
  const { events } = parseFixture('doc-post-share');
  assert.equal(events.length, 1);
  assert.partialDeepStrictEqual(events[0], {
    kind: 'message',
    mid: 'MID_DOC_POST_SHARE',
    text: null,
    attachmentTypes: ['ig_post'],
  });
});

test('ignores echoes of messages the account sent', () => {
  assert.deepEqual(parseFixture('doc-echo').events, [
    { kind: 'ignored', reason: 'echo', accountId: ACCOUNT_ID, mid: 'MID_DOC_ECHO' },
  ]);
});

test('accepts a reel the account sent to itself, addressed to the recipient ID', () => {
  const { events } = parseFixture('doc-self-reel');
  assert.equal(events.length, 1);
  assert.partialDeepStrictEqual(events[0], {
    kind: 'reel',
    mid: 'MID_DOC_SELF_REEL',
    isSelf: true,
    igsid: '9876543210987654',
    reel: { attachmentType: 'ig_reel', title: null, videoId: '18139494541428835' },
  });
});

test('ignores read receipts', () => {
  assert.deepEqual(parseFixture('doc-read').events, [
    { kind: 'ignored', reason: 'read', accountId: ACCOUNT_ID, mid: 'MID_DOC_READ' },
  ]);
});

test('parses the dashboard test payload, which uses changes[] and a string timestamp', () => {
  assert.deepEqual(parseFixture('doc-dashboard-test').events, [
    {
      kind: 'message',
      accountId: '0',
      igsid: '12334',
      mid: 'random_mid',
      timestamp: 1527459824,
      isSelf: false,
      text: 'random_text',
      attachmentTypes: [],
    },
  ]);
});

test('ignores deleted messages, reactions, and items it does not recognize', () => {
  const item = (extra: object) => ({
    sender: { id: SENDER_ID },
    recipient: { id: ACCOUNT_ID },
    timestamp: 1,
    ...extra,
  });
  const { events } = parseWebhook({
    object: 'instagram',
    entry: [
      {
        id: ACCOUNT_ID,
        messaging: [
          item({ message: { mid: 'M1', is_deleted: true } }),
          item({ reaction: { mid: 'M2', action: 'react', reaction: 'love' } }),
          item({ message: { text: 'no mid' } }),
          item({ something_new: {} }),
          'not an object',
        ],
        changes: [{ field: 'comments', value: { id: 'C1', text: 'nice' } }],
      },
    ],
  });
  assert.deepEqual(
    events.map((event) => (event.kind === 'ignored' ? event.reason : event.kind)),
    ['deleted', 'reaction', 'no_message_id', 'unrecognized', 'unrecognized', 'unrecognized'],
  );
});

test('produces no events for payloads that are not Instagram webhooks', () => {
  assert.deepEqual(parseWebhook({ object: 'page', entry: [{ messaging: [{}] }] }), {
    object: 'page',
    events: [],
  });
  assert.deepEqual(parseWebhook(null), { object: null, events: [] });
  assert.deepEqual(parseWebhook('instagram'), { object: null, events: [] });
  assert.deepEqual(parseWebhook({ object: 'instagram' }), { object: 'instagram', events: [] });
});

test('parseJsonKeepingBigIntegers keeps oversized integers exact and leaves other numbers alone', () => {
  const parsed = parseJsonKeepingBigIntegers(
    '{"big":18139494541428835,"negative":-18139494541428835,"safe":1761287294014,"float":1.5,"text":"18139494541428835"}',
  );
  assert.deepEqual(parsed, {
    big: '18139494541428835',
    negative: '-18139494541428835',
    safe: 1761287294014,
    float: 1.5,
    text: '18139494541428835',
  });
});
