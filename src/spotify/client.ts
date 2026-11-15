/**
 * The Spotify calls SongSnag makes, written against the Web API reference as
 * read on 2026-11-14 (after the February 2026 changes):
 *
 * - playlists are created with `POST /me/playlists`
 * - playlist contents are under `/playlists/{id}/items`, and each entry holds
 *   its track in `item`
 * - search returns at most 10 results
 * - a refresh token lasts six months from the day of authorization, and a
 *   refused one comes back as `invalid_grant`
 *
 * Nothing here throws for an HTTP or network failure: every call returns a
 * result the caller has to look at.
 */

const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';

/**
 * `playlist-modify-*` create the playlist and add to it. `playlist-read-private`
 * is what Spotify asks for to list a private playlist's contents, which is how
 * songs that are already there get skipped.
 */
export const SCOPES = ['playlist-modify-private', 'playlist-modify-public', 'playlist-read-private'];

/** Spotify's search limit since February 2026. */
const SEARCH_LIMIT = 10;
const PLAYLIST_PAGE = 50;
/** Stop reading a playlist after this many pages (5,000 songs). */
const MAX_PLAYLIST_PAGES = 100;
/** A rate-limited call is retried once if Spotify asks for a wait no longer than this. */
const MAX_RETRY_AFTER_SECONDS = 5;
const REQUEST_TIMEOUT_MS = 15_000;

export type SpotifyConfig = {
  clientId: string;
  clientSecret: string;
  /** Must match a redirect URI registered in the Spotify dashboard exactly. */
  redirectUri: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type Tokens = {
  accessToken: string;
  /** Spotify may leave this out of a refresh response; the old one then stays valid. */
  refreshToken: string | null;
  expiresInSeconds: number;
};

export type TokenResult =
  | { ok: true; tokens: Tokens }
  /** `invalid-grant`: the code or refresh token is no longer accepted. The person has to authorize again. */
  | { ok: false; reason: 'invalid-grant' | 'failed'; detail: string };

export type ApiFailure = {
  ok: false;
  /**
   * `unauthorized`: the access token expired or was revoked.
   * `forbidden`: Spotify refused. In Development Mode this is what a person
   * who is not on the app's user list gets.
   */
  reason: 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'failed';
  detail: string;
};

export type ApiResult<T> = { ok: true; value: T } | ApiFailure;

export type Track = {
  uri: string;
  name: string;
  artists: string[];
};

export type Spotify = ReturnType<typeof createSpotify>;

export function createSpotify(config: SpotifyConfig) {
  const doFetch = config.fetch ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function token(form: Record<string, string>): Promise<TokenResult> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    let response: Response;
    try {
      response = await doFetch(`${ACCOUNTS_URL}/api/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, reason: 'failed', detail: `network: ${String(error)}` };
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = isRecord(body) && typeof body.error === 'string' ? body.error : null;
      return {
        ok: false,
        reason: code === 'invalid_grant' ? 'invalid-grant' : 'failed',
        detail: `HTTP ${response.status}${code ? ` ${code}` : ''}`,
      };
    }
    if (!isRecord(body) || typeof body.access_token !== 'string') {
      return { ok: false, reason: 'failed', detail: 'the token response had no access token' };
    }
    return {
      ok: true,
      tokens: {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
        expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : 3600,
      },
    };
  }

  async function api(
    accessToken: string,
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<ApiResult<unknown>> {
    const url = new URL(`${API_URL}${path}`);
    for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        return { ok: false, reason: 'failed', detail: `network: ${String(error)}` };
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) return { ok: true, value: body };

      if (response.status === 429 && attempt === 0) {
        const wait = Number(response.headers.get('retry-after') ?? '1');
        if (Number.isFinite(wait) && wait <= MAX_RETRY_AFTER_SECONDS) {
          await sleep(Math.max(wait, 0) * 1000);
          continue;
        }
      }
      const message =
        isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
          ? body.error.message
          : '';
      const reasons: Record<number, ApiFailure['reason']> = {
        401: 'unauthorized',
        403: 'forbidden',
        404: 'not-found',
        429: 'rate-limited',
      };
      return {
        ok: false,
        reason: reasons[response.status] ?? 'failed',
        detail: `${method} ${path}: HTTP ${response.status}${message ? ` ${message}` : ''}`,
      };
    }
  }

  return {
    /** Where to send someone to authorize SongSnag. `state` comes back on the callback. */
    authorizeUrl(state: string): string {
      const url = new URL(`${ACCOUNTS_URL}/authorize`);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('scope', SCOPES.join(' '));
      url.searchParams.set('state', state);
      return url.toString();
    },

    exchangeCode(code: string): Promise<TokenResult> {
      return token({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri });
    },

    refresh(refreshToken: string): Promise<TokenResult> {
      return token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    /** The Spotify user ID behind an access token. */
    async currentUserId(accessToken: string): Promise<ApiResult<string>> {
      const result = await api(accessToken, 'GET', '/me');
      if (!result.ok) return result;
      if (!isRecord(result.value) || typeof result.value.id !== 'string') {
        return { ok: false, reason: 'failed', detail: 'GET /me returned no id' };
      }
      return { ok: true, value: result.value.id };
    },

    /** Creates a private playlist in the token owner's account and returns its ID. */
    async createPlaylist(
      accessToken: string,
      playlist: { name: string; description: string },
    ): Promise<ApiResult<string>> {
      const result = await api(accessToken, 'POST', '/me/playlists', {
        body: { name: playlist.name, description: playlist.description, public: false },
      });
      if (!result.ok) return result;
      if (!isRecord(result.value) || typeof result.value.id !== 'string') {
        return { ok: false, reason: 'failed', detail: 'POST /me/playlists returned no id' };
      }
      return { ok: true, value: result.value.id };
    },

    /** Up to 10 tracks for a free-text query, in Spotify's order of relevance. */
    async searchTracks(accessToken: string, query: string): Promise<ApiResult<Track[]>> {
      const result = await api(accessToken, 'GET', '/search', {
        query: { q: query, type: 'track', limit: String(SEARCH_LIMIT) },
      });
      if (!result.ok) return result;
      const tracks = isRecord(result.value) && isRecord(result.value.tracks) ? result.value.tracks.items : null;
      return { ok: true, value: (Array.isArray(tracks) ? tracks : []).flatMap(toTrack) };
    },

    /** The URIs of everything in a playlist. */
    async playlistUris(accessToken: string, playlistId: string): Promise<ApiResult<Set<string>>> {
      const uris = new Set<string>();
      for (let page = 0; page < MAX_PLAYLIST_PAGES; page += 1) {
        const result = await api(accessToken, 'GET', `/playlists/${encodeURIComponent(playlistId)}/items`, {
          query: {
            limit: String(PLAYLIST_PAGE),
            offset: String(page * PLAYLIST_PAGE),
            fields: 'next,items(item(uri))',
          },
        });
        if (!result.ok) return result;
        const body = isRecord(result.value) ? result.value : {};
        for (const entry of Array.isArray(body.items) ? body.items : []) {
          const item = isRecord(entry) ? entry.item : null;
          if (isRecord(item) && typeof item.uri === 'string') uris.add(item.uri);
        }
        if (typeof body.next !== 'string') break;
      }
      return { ok: true, value: uris };
    },

    /** Appends tracks to a playlist. Spotify accepts 100 URIs per request. */
    async addToPlaylist(accessToken: string, playlistId: string, uris: string[]): Promise<ApiResult<null>> {
      for (let start = 0; start < uris.length; start += 100) {
        const result = await api(accessToken, 'POST', `/playlists/${encodeURIComponent(playlistId)}/items`, {
          body: { uris: uris.slice(start, start + 100) },
        });
        if (!result.ok) return result;
      }
      return { ok: true, value: null };
    },
  };
}

function toTrack(value: unknown): Track[] {
  if (!isRecord(value) || typeof value.uri !== 'string' || typeof value.name !== 'string') return [];
  if (value.type !== undefined && value.type !== 'track') return [];
  const artists = (Array.isArray(value.artists) ? value.artists : []).flatMap((artist) =>
    isRecord(artist) && typeof artist.name === 'string' ? [artist.name] : [],
  );
  return [{ uri: value.uri, name: value.name, artists }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
