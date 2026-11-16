import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { hashToken, randomToken, type TokenCipher } from './crypto.ts';
import type { Track } from './spotify/client.ts';

/**
 * SQLite storage: who has linked Spotify, the one-time links, and one row per
 * message SongSnag has acted on (which is also what makes webhook retries
 * harmless). It also remembers the songs each reel names, so a reel that is
 * sent again, by anyone, is not downloaded and read a second time.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  igsid             TEXT PRIMARY KEY,
  spotify_user_id   TEXT NOT NULL,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  playlist_id       TEXT NOT NULL,
  needs_relink      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link_tokens (
  token_hash TEXT PRIMARY KEY,
  igsid      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE TABLE IF NOT EXISTS reels (
  mid        TEXT PRIMARY KEY,
  igsid      TEXT NOT NULL,
  url        TEXT,
  caption    TEXT,
  status     TEXT NOT NULL,
  matched    TEXT,
  error      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reels_by_igsid_status ON reels (igsid, status);
CREATE TABLE IF NOT EXISTS reel_songs (
  shortcode  TEXT PRIMARY KEY,
  songs      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export type ReelStatus =
  /** Accepted, waiting for its turn. */
  | 'queued'
  /** Waiting for the sender to link Spotify. */
  | 'pending_link'
  | 'processing'
  | 'done'
  | 'failed'
  /** A message that got a reply but is not a reel to process (unsupported share, other attachment). */
  | 'answered';

export type ReelRow = {
  mid: string;
  igsid: string;
  url: string | null;
  caption: string | null;
  status: ReelStatus;
  /** JSON of what happened to each song, for debugging. */
  matched: string | null;
  error: string | null;
  createdAt: number;
};

export type User = {
  igsid: string;
  spotifyUserId: string;
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  accessExpiresAt: number;
  playlistId: string;
  /** Spotify refused the refresh token; the person has to link again. */
  needsRelink: boolean;
};

/**
 * A song found in a reel, as kept in `reel_songs`. `heard` marks one that was
 * identified from the music playing instead of being named, and `track` is
 * its Spotify entry when the fingerprinting service supplied one. Rows saved
 * before fingerprinting existed have neither field.
 */
export type ReelSong = { title: string; artist: string | null; heard?: true; track?: Track };

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string, cipher: TokenCipher, now: () => number = Date.now) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const toReel = (row: Record<string, unknown>): ReelRow => ({
    mid: row.mid as string,
    igsid: row.igsid as string,
    url: row.url as string | null,
    caption: row.caption as string | null,
    status: row.status as ReelStatus,
    matched: row.matched as string | null,
    error: row.error as string | null,
    createdAt: row.created_at as number,
  });

  return {
    /**
     * Records a message the first time it is seen. Returns false if it was
     * already recorded, which means this delivery is one of Meta's retries.
     */
    claimMessage(message: {
      mid: string;
      igsid: string;
      url: string | null;
      caption: string | null;
      status: ReelStatus;
    }): boolean {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO reels (mid, igsid, url, caption, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(message.mid, message.igsid, message.url, message.caption, message.status, now(), now());
      return result.changes === 1;
    },

    setReelStatus(mid: string, status: ReelStatus, detail: { matched?: unknown; error?: string | null } = {}): void {
      db.prepare(
        `UPDATE reels SET status = ?, matched = COALESCE(?, matched), error = ?, updated_at = ? WHERE mid = ?`,
      ).run(
        status,
        detail.matched === undefined ? null : JSON.stringify(detail.matched),
        detail.error ?? null,
        now(),
        mid,
      );
    },

    getReel(mid: string): ReelRow | null {
      const row = db.prepare('SELECT * FROM reels WHERE mid = ?').get(mid) as Record<string, unknown> | undefined;
      return row ? toReel(row) : null;
    },

    /** Reels of this person that are waiting for a link, oldest first, no older than `since`. */
    pendingReels(igsid: string, since: number): ReelRow[] {
      const rows = db
        .prepare(
          `SELECT * FROM reels WHERE igsid = ? AND status = 'pending_link' AND created_at >= ? ORDER BY created_at`,
        )
        .all(igsid, since) as Record<string, unknown>[];
      return rows.map(toReel);
    },

    /** Reels that were queued or being processed when the server last stopped. */
    interruptedReels(): ReelRow[] {
      const rows = db
        .prepare(`SELECT * FROM reels WHERE status IN ('queued', 'processing') ORDER BY created_at`)
        .all() as Record<string, unknown>[];
      return rows.map(toReel);
    },

    /**
     * The songs a reel was found to name, by the shortcode in its link, or null
     * if the reel has not been read yet. An empty list is a real answer: the
     * reel was read and names nothing.
     */
    getReelSongs(shortcode: string): ReelSong[] | null {
      const row = db.prepare('SELECT songs FROM reel_songs WHERE shortcode = ?').get(shortcode) as
        | { songs: string }
        | undefined;
      return row ? (JSON.parse(row.songs) as ReelSong[]) : null;
    },

    /** Not tied to a person, so deleting a person leaves it in place. */
    saveReelSongs(shortcode: string, songs: ReelSong[]): void {
      db.prepare(
        `INSERT INTO reel_songs (shortcode, songs, created_at) VALUES (?, ?, ?)
         ON CONFLICT (shortcode) DO UPDATE SET songs = excluded.songs, created_at = excluded.created_at`,
      ).run(
        shortcode,
        JSON.stringify(
          songs.map(({ title, artist, heard, track }) => ({
            title,
            artist,
            ...(heard ? { heard } : {}),
            ...(track ? { track: { uri: track.uri, name: track.name, artists: track.artists } } : {}),
          })),
        ),
        now(),
      );
    },

    getUser(igsid: string): User | null {
      const row = db.prepare('SELECT * FROM users WHERE igsid = ?').get(igsid) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      return {
        igsid: row.igsid as string,
        spotifyUserId: row.spotify_user_id as string,
        accessToken: cipher.decrypt(row.access_token as string),
        refreshToken: cipher.decrypt(row.refresh_token as string),
        accessExpiresAt: row.access_expires_at as number,
        playlistId: row.playlist_id as string,
        needsRelink: row.needs_relink === 1,
      };
    },

    /** Creates or replaces a person's Spotify link. Clears `needsRelink`. */
    saveUser(user: Omit<User, 'needsRelink'>): void {
      db.prepare(
        `INSERT INTO users (igsid, spotify_user_id, access_token, refresh_token, access_expires_at, playlist_id, needs_relink, created_at, updated_at)
         VALUES (@igsid, @spotifyUserId, @accessToken, @refreshToken, @accessExpiresAt, @playlistId, 0, @now, @now)
         ON CONFLICT (igsid) DO UPDATE SET
           spotify_user_id = excluded.spotify_user_id,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           access_expires_at = excluded.access_expires_at,
           playlist_id = excluded.playlist_id,
           needs_relink = 0,
           updated_at = excluded.updated_at`,
      ).run({
        igsid: user.igsid,
        spotifyUserId: user.spotifyUserId,
        accessToken: cipher.encrypt(user.accessToken),
        refreshToken: cipher.encrypt(user.refreshToken),
        accessExpiresAt: user.accessExpiresAt,
        playlistId: user.playlistId,
        now: now(),
      });
    },

    saveTokens(igsid: string, tokens: { accessToken: string; refreshToken: string; accessExpiresAt: number }): void {
      db.prepare(
        `UPDATE users SET access_token = ?, refresh_token = ?, access_expires_at = ?, updated_at = ? WHERE igsid = ?`,
      ).run(
        cipher.encrypt(tokens.accessToken),
        cipher.encrypt(tokens.refreshToken),
        tokens.accessExpiresAt,
        now(),
        igsid,
      );
    },

    markNeedsRelink(igsid: string): void {
      db.prepare('UPDATE users SET needs_relink = 1, updated_at = ? WHERE igsid = ?').run(now(), igsid);
    },

    /** Removes everything held about one person. Returns how many rows went. */
    deleteUser(igsid: string): { users: number; links: number; reels: number } {
      return db.transaction(() => ({
        users: db.prepare('DELETE FROM users WHERE igsid = ?').run(igsid).changes,
        links: db.prepare('DELETE FROM link_tokens WHERE igsid = ?').run(igsid).changes,
        reels: db.prepare('DELETE FROM reels WHERE igsid = ?').run(igsid).changes,
      }))();
    },

    /** Issues a one-time link token. Only its hash is stored. */
    createLinkToken(igsid: string, ttlMs: number): string {
      const token = randomToken();
      db.prepare('DELETE FROM link_tokens WHERE expires_at < ?').run(now() - 24 * 60 * 60 * 1000);
      db.prepare('INSERT INTO link_tokens (token_hash, igsid, expires_at) VALUES (?, ?, ?)').run(
        hashToken(token),
        igsid,
        now() + ttlMs,
      );
      return token;
    },

    /** The person a link token belongs to, if it is unused and unexpired. Does not use it up. */
    peekLinkToken(token: string): string | null {
      const row = db
        .prepare('SELECT igsid FROM link_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
        .get(hashToken(token), now()) as { igsid: string } | undefined;
      return row?.igsid ?? null;
    },

    /** Uses a link token up. Returns its person, or null if it was not valid any more. */
    consumeLinkToken(token: string): string | null {
      const row = db
        .prepare(
          `UPDATE link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING igsid`,
        )
        .get(now(), hashToken(token), now()) as { igsid: string } | undefined;
      return row?.igsid ?? null;
    },

    /** Makes a token usable again after a sign-in that failed on our side. */
    restoreLinkToken(token: string): void {
      db.prepare('UPDATE link_tokens SET used_at = NULL WHERE token_hash = ?').run(hashToken(token));
    },

    close(): void {
      db.close();
    },
  };
}
