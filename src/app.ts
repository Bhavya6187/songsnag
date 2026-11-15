import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { captureWebhookBody } from './capture.ts';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import { verifySignature } from './instagram/signature.ts';
import {
  parseJsonKeepingBigIntegers,
  parseWebhook,
  type InboundEvent,
} from './instagram/webhook.ts';
import { completeLink } from './linking.ts';
import type { Logger } from './log.ts';
import type { Pipeline } from './pipeline.ts';
import { renderLinkPage, renderNotFound, renderPage, type LinkPage, type SitePage } from './site.ts';
import type { Spotify } from './spotify/client.ts';

/** Meta's webhook bodies are a few kilobytes. Anything near this is not Meta. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

export type AppDeps = {
  config: Pick<
    Config,
    'metaAppSecret' | 'metaVerifyToken' | 'captureDir' | 'igHandle' | 'contactEmail'
  >;
  log: Logger;
  /**
   * The reel-to-playlist service. Without it the webhook only verifies and
   * logs, and the linking routes do not exist.
   */
  service?: Service | null;
};

export type Service = { store: Store; spotify: Spotify; pipeline: Pipeline; now?: () => number };

export function createApp({ config, log, service = null }: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.text('ok'));

  // Public pages. The privacy, terms and data-deletion URLs are the ones
  // entered in the Meta and Spotify dashboards, so their paths must not change.
  const pages: Record<string, SitePage> = {
    '/': 'home',
    '/privacy': 'privacy',
    '/terms': 'terms',
    '/data-deletion': 'data-deletion',
  };
  for (const [path, page] of Object.entries(pages)) {
    app.get(path, (c) => {
      setPageHeaders(c);
      return c.html(renderPage(page, config));
    });
  }
  app.notFound((c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Not found', 404);
    setPageHeaders(c);
    return c.html(renderNotFound(), 404);
  });

  // Verification handshake. Meta calls this once when the callback URL is
  // saved in the App Dashboard and expects the challenge echoed back.
  app.get('/webhook/instagram', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');

    if (
      mode !== 'subscribe' ||
      token === undefined ||
      challenge === undefined ||
      !constantTimeEqual(token, config.metaVerifyToken)
    ) {
      log.warn('webhook verification rejected', { mode: mode ?? null, hasToken: token !== undefined });
      return c.text('Forbidden', 403);
    }
    log.info('webhook verification succeeded');
    return c.text(challenge);
  });

  app.post(
    '/webhook/instagram',
    bodyLimit({
      maxSize: MAX_WEBHOOK_BYTES,
      onError: (c) => c.text('Payload too large', 413),
    }),
    async (c) => {
      // The signature covers the exact bytes Meta sent, so read the body raw
      // and verify it before parsing anything.
      const rawBody = Buffer.from(await c.req.arrayBuffer());
      const signature = verifySignature(
        rawBody,
        c.req.header('x-hub-signature-256'),
        config.metaAppSecret,
      );
      if (!signature.ok) {
        log.warn('webhook rejected: signature check failed', {
          reason: signature.reason,
          bytes: rawBody.length,
        });
        return c.text('Invalid signature', 401);
      }

      let capturedTo: string | null = null;
      if (config.captureDir !== null) {
        try {
          capturedTo = await captureWebhookBody(config.captureDir, rawBody);
        } catch (error) {
          log.error('could not capture webhook body', { error: String(error) });
        }
      }

      let payload: unknown;
      try {
        payload = parseJsonKeepingBigIntegers(rawBody.toString('utf8'));
      } catch {
        log.error('webhook body is not valid JSON', { bytes: rawBody.length, capturedTo });
        return c.text('Invalid JSON', 400);
      }

      const { object, events } = parseWebhook(payload);
      log.info('webhook received', { object, events: events.length, capturedTo });
      for (const event of events) {
        logEvent(log, event);
        // Returns at once: the reply to Meta must not wait for the reel to be processed.
        service?.pipeline.handle(event);
      }

      return c.text('EVENT_RECEIVED');
    },
  );

  if (service !== null) {
    const { store, spotify, pipeline, now } = service;
    const linkPage = (c: Context, page: LinkPage, status: 200 | 400 | 410 | 502 = 200) => {
      setPageHeaders(c);
      // These pages are personal and one-off.
      c.header('Cache-Control', 'no-store');
      return c.html(renderLinkPage(page), status);
    };

    // The one-time link sent in a DM. Opening it does not use it up: messaging
    // apps fetch links to build previews, and that must not burn the link. It
    // is used up when Spotify sends the person back.
    app.get('/link/:token', (c) => {
      const token = c.req.param('token');
      if (store.peekLinkToken(token) === null) return linkPage(c, 'expired', 410);
      c.header('Cache-Control', 'no-store');
      c.header('Referrer-Policy', 'no-referrer');
      return c.redirect(spotify.authorizeUrl(token), 302);
    });

    app.get('/auth/spotify/callback', async (c) => {
      const state = c.req.query('state');
      const code = c.req.query('code');
      if (state === undefined) return linkPage(c, 'expired', 400);
      if (code === undefined) {
        // Spotify sends `error=access_denied` when the person pressed Cancel.
        log.info('spotify sign-in not completed', { error: c.req.query('error') ?? null });
        return linkPage(c, store.peekLinkToken(state) === null ? 'expired' : 'declined', 400);
      }

      const outcome = await completeLink({ store, spotify, log, now }, { state, code });
      if (outcome.result === 'linked') {
        pipeline.linked(outcome.igsid);
        return linkPage(c, 'linked');
      }
      return linkPage(c, outcome.result, outcome.result === 'expired' ? 410 : 502);
    });
  }

  return app;
}

/** The pages are fully inline, so nothing may be loaded from anywhere else. */
function setPageHeaders(c: Context): void {
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'public, max-age=300');
}

function logEvent(log: Logger, event: InboundEvent): void {
  switch (event.kind) {
    case 'reel':
      log.info('reel received', {
        mid: event.mid,
        igsid: event.igsid,
        isSelf: event.isSelf,
        attachmentType: event.reel.attachmentType,
        title: event.reel.title,
        videoId: event.reel.videoId,
        url: event.reel.url,
      });
      return;
    case 'unsupported':
      log.warn('unsupported message received', {
        mid: event.mid,
        igsid: event.igsid,
        isSelf: event.isSelf,
        reason: event.reason,
      });
      return;
    case 'message':
      // Message text is the user's own words. Log that it exists, not what it says.
      log.info('message received without a reel', {
        mid: event.mid,
        igsid: event.igsid,
        isSelf: event.isSelf,
        hasText: event.text !== null,
        attachmentTypes: event.attachmentTypes,
      });
      return;
    case 'ignored':
      log.info('event ignored', { reason: event.reason, mid: event.mid });
      return;
  }
}

/** String comparison that does not leak, through timing, how much of the input matched. */
function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}
