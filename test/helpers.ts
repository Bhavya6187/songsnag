import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LogFields, Logger } from '../src/log.ts';

/** Reads an Instagram webhook fixture as the exact text Meta would have sent. */
export function instagramFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/instagram/${name}.json`, import.meta.url), 'utf8');
}

/** Builds the `X-Hub-Signature-256` header value Meta would send for `body`. */
export function sign(body: string | Uint8Array, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export type LogRecord = { level: 'info' | 'warn' | 'error'; msg: string; fields: LogFields };

/** A logger that keeps its records in memory so tests can assert on them. */
export function recordingLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const at =
    (level: LogRecord['level']) =>
    (msg: string, fields: LogFields = {}) => {
      records.push({ level, msg, fields });
    };
  return { records, info: at('info'), warn: at('warn'), error: at('error') };
}

export type RecordedRequest = { method: string; url: URL; headers: Headers; body: string };

/** A `fetch` that answers from `respond` and keeps every request it was given. */
export function fakeFetch(respond: (request: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return { fetch: fetchFake, requests };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Reads a Spotify response fixture. */
export function spotifyFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/spotify/${name}.json`, import.meta.url), 'utf8'));
}

export type CatalogTrack = { uri: string; name: string; artists: string[] };

/**
 * A stand-in for Spotify's accounts and Web API hosts, shaped after the
 * reference as read on 2026-11-14. It keeps one playlist and a small catalog
 * that search answers from by matching words in the query.
 */
export function fakeSpotifyApi(options: { catalog?: CatalogTrack[]; playlist?: string[] } = {}) {
  const state = {
    catalog: options.catalog ?? [],
    playlist: [...(options.playlist ?? [])],
    /** Access tokens the API accepts. */
    validAccessTokens: new Set(['access-1']),
    /** What the next refresh returns: a new access token, or an error code. */
    refresh: { accessToken: 'access-2' } as { accessToken: string } | { error: string },
    /** HTTP status to answer every Web API call with, to simulate an outage or a refusal. */
    apiStatus: null as number | null,
    userId: 'spotify-user-1',
    createdPlaylists: [] as Record<string, unknown>[],
  };

  const { fetch, requests } = fakeFetch(({ method, url, headers, body }) => {
    if (url.host === 'accounts.spotify.com' && url.pathname === '/api/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code') return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1', scope: '' });
      }
      if ('error' in state.refresh) return json({ error: state.refresh.error }, 400);
      state.validAccessTokens.add(state.refresh.accessToken);
      return json({ access_token: state.refresh.accessToken, token_type: 'Bearer', expires_in: 3600, scope: '' });
    }

    if (state.apiStatus !== null) return json({ error: { status: state.apiStatus, message: 'simulated' } }, state.apiStatus);
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!state.validAccessTokens.has(bearer)) {
      return json({ error: { status: 401, message: 'The access token expired' } }, 401);
    }

    const path = url.pathname.replace(/^\/v1/, '');
    if (method === 'GET' && path === '/me') return json({ id: state.userId, type: 'user' });
    if (method === 'POST' && path === '/me/playlists') {
      state.createdPlaylists.push(JSON.parse(body) as Record<string, unknown>);
      return json({ id: `playlist-${state.createdPlaylists.length}`, name: 'SongSnag' }, 201);
    }
    if (method === 'GET' && path === '/search') {
      const words = (url.searchParams.get('q') ?? '').toLowerCase().replace(/\b(track|artist):/g, '').split(/\s+/);
      const items = state.catalog
        .filter((track) => words.some((word) => word !== '' && `${track.name} ${track.artists.join(' ')}`.toLowerCase().includes(word)))
        .map((track) => ({ type: 'track', uri: track.uri, name: track.name, artists: track.artists.map((name) => ({ name })) }));
      return json({ tracks: { items, total: items.length, next: null } });
    }
    if (method === 'GET' && /^\/playlists\/[^/]+\/items$/.test(path)) {
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      const page = state.playlist.slice(offset, offset + limit);
      return json({
        items: page.map((uri) => ({ item: { uri } })),
        next: offset + limit < state.playlist.length ? 'https://api.spotify.com/v1/next-page' : null,
      });
    }
    if (method === 'POST' && /^\/playlists\/[^/]+\/items$/.test(path)) {
      state.playlist.push(...(JSON.parse(body) as { uris: string[] }).uris);
      return json({ snapshot_id: 'abc' }, 201);
    }
    return json({ error: { status: 404, message: 'Not found' } }, 404);
  });

  return { fetch, requests, state };
}
