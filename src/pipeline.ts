import type { ReelSong, Store, User } from './db.ts';
import type { SendText } from './instagram/send.ts';
import type { InboundEvent } from './instagram/webhook.ts';
import type { Logger } from './log.ts';
import type { Recognition, RecognizeInput } from './recognize/reel.ts';
import { reelShortcode } from './reel/download.ts';
import type { ApiFailure, ApiResult, Spotify, Track } from './spotify/client.ts';
import { pickTrack, searchQueries } from './spotify/match.ts';

/**
 * What happens after a webhook is acknowledged: a shared reel is recognised,
 * its songs are looked up on Spotify and added to the sender's playlist, and
 * the sender gets a DM saying what happened.
 *
 * Reels are processed one at a time. Each one downloads a video and runs
 * ffmpeg, and the service has five users.
 */

/** How long a link to the Spotify sign-in stays valid. */
export const LINK_TTL_MS = 60 * 60 * 1000;

/**
 * Meta allows replies for 24 hours after the person's last message. A reel
 * older than this is not answered, with an hour to spare.
 */
const REPLY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Refresh an access token this long before Spotify says it expires. */
const EXPIRY_MARGIN_MS = 60 * 1000;

export type SongOutcome =
  | { song: ReelSong; result: 'added' | 'already'; track: Track; artistUnconfirmed: boolean }
  | { song: ReelSong; result: 'not-found' };

export type PipelineDeps = {
  store: Store;
  spotify: Spotify;
  send: SendText;
  log: Logger;
  recognize: (input: RecognizeInput) => Promise<Recognition>;
  /** Public base URL of this server, no trailing slash. */
  baseUrl: string;
  /** Whether reels that name no song are fingerprinted. Only changes the wording of the "no songs" DM. */
  fingerprinting?: boolean;
  now?: () => number;
};

export type Pipeline = ReturnType<typeof createPipeline>;

export const REPLIES = {
  link: (url: string) =>
    `Hi, this is SongSnag. To add songs from reels to your playlist, link your Spotify account first:\n${url}\nThe link works once and lasts an hour. After that I'll add the songs from the reel you sent.`,
  relink: (url: string) =>
    `Your Spotify link has run out, so I need you to link again:\n${url}\nThe link works once and lasts an hour. After that I'll add the songs from the reel you sent.`,
  linked: 'Spotify is linked. Songs go to your private "SongSnag" playlist.',
  unsupported: "That reel didn't come through on my side. Please send it again.",
  notAReel: 'I only work with reels. Share a reel with me and I add the songs it names to your playlist.',
  restricted: "I couldn't open that reel. It is private or limited to some viewers, so I can't read it.",
  reelGone: "I couldn't open that reel. It may have been deleted.",
  reelFailed: 'Something went wrong on my side while reading that reel. Please send it again in a few minutes.',
  noSongs:
    "I couldn't find a song named in that reel. I read the caption, the text on screen and what is said, so a song that only plays in the background is one I miss.",
  noSongsHeard:
    "I couldn't find a song in that reel. Nothing is named in the caption, on screen or in what is said, and I didn't recognise the music playing in it.",
  notInvited:
    "Spotify wouldn't let me add to your playlist. Ask whoever invited you to check that your Spotify account is on the SongSnag invite list.",
  spotifyFailed: "Spotify isn't answering me right now. Please send the reel again in a few minutes.",
  interrupted: 'I restarted while working on your reel. Please send it again.',
};

export function createPipeline(deps: PipelineDeps) {
  const { store, spotify, send, log } = deps;
  const now = deps.now ?? Date.now;

  // One job at a time, in the order they were accepted.
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (name: string, job: () => Promise<void>): void => {
    tail = tail.then(job).catch((error: unknown) => {
      log.error('background job failed', { job: name, error: String(error) });
    });
  };

  async function reply(igsid: string, text: string, mid: string | null): Promise<void> {
    const result = await send(igsid, text);
    if (!result.ok) log.error('could not send DM', { igsid, mid, detail: result.detail });
  }

  async function sendLink(igsid: string, mid: string, kind: 'link' | 'relink'): Promise<void> {
    const token = store.createLinkToken(igsid, LINK_TTL_MS);
    store.setReelStatus(mid, 'pending_link');
    await reply(igsid, REPLIES[kind](`${deps.baseUrl}/link/${token}`), mid);
    log.info('link sent', { igsid, mid, kind });
  }

  /**
   * A person's access token, refreshed when it is about to expire and again
   * if Spotify rejects it mid-way. `relink` means the refresh token is dead.
   */
  async function openSession(user: User) {
    let accessToken = user.accessToken;
    let refreshToken = user.refreshToken;

    const refresh = async (): Promise<'ok' | 'relink' | 'failed'> => {
      const result = await spotify.refresh(refreshToken);
      if (!result.ok) {
        log.warn('token refresh failed', { igsid: user.igsid, reason: result.reason, detail: result.detail });
        return result.reason === 'invalid-grant' ? 'relink' : 'failed';
      }
      accessToken = result.tokens.accessToken;
      refreshToken = result.tokens.refreshToken ?? refreshToken;
      store.saveTokens(user.igsid, {
        accessToken,
        refreshToken,
        accessExpiresAt: now() + result.tokens.expiresInSeconds * 1000,
      });
      return 'ok';
    };

    if (user.accessExpiresAt - EXPIRY_MARGIN_MS <= now()) {
      const refreshed = await refresh();
      if (refreshed !== 'ok') return { ok: false as const, reason: refreshed };
    }

    let retried = false;
    return {
      ok: true as const,
      async call<T>(request: (accessToken: string) => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
        const result = await request(accessToken);
        if (result.ok || result.reason !== 'unauthorized' || retried) return result;
        retried = true;
        return (await refresh()) === 'ok' ? request(accessToken) : result;
      },
    };
  }

  async function processReel(mid: string): Promise<void> {
    const reel = store.getReel(mid);
    if (reel === null || reel.url === null) return;
    const { igsid } = reel;

    if (now() - reel.createdAt > REPLY_WINDOW_MS) {
      store.setReelStatus(mid, 'failed', { error: 'too old to answer' });
      return;
    }

    const user = store.getUser(igsid);
    if (user === null) return sendLink(igsid, mid, 'link');
    if (user.needsRelink) return sendLink(igsid, mid, 'relink');

    const fail = async (error: string, text: string): Promise<void> => {
      store.setReelStatus(mid, 'failed', { error });
      log.warn('reel failed', { mid, igsid, error });
      await reply(igsid, text, mid);
    };
    const spotifyFail = (failure: ApiFailure): Promise<void> =>
      fail(`spotify ${failure.reason}: ${failure.detail}`, failure.reason === 'forbidden' ? REPLIES.notInvited : REPLIES.spotifyFailed);

    store.setReelStatus(mid, 'processing');

    // The token is checked before the reel is read, so a dead link costs nothing.
    const session = await openSession(user);
    if (!session.ok) {
      if (session.reason === 'relink') {
        store.markNeedsRelink(igsid);
        return sendLink(igsid, mid, 'relink');
      }
      return fail('spotify token refresh failed', REPLIES.spotifyFailed);
    }

    // Reading a reel is the slow, paid part, and a reel names the same songs
    // whoever sends it. So the answer is kept by the reel's shortcode and
    // reused. Failures are not kept: the next send tries again.
    const shortcode = reelShortcode(reel.url);
    let songs: ReelSong[] | null = shortcode === null ? null : store.getReelSongs(shortcode);
    if (songs !== null) {
      log.info('reel songs reused', { mid, shortcode, songs: songs.length });
    } else {
      const recognition = await deps.recognize({ url: reel.url, caption: reel.caption });
      if (!recognition.ok) {
        const error = `${recognition.stage} ${recognition.reason}: ${recognition.detail}`;
        if (recognition.stage === 'download' && recognition.reason === 'restricted') return fail(error, REPLIES.restricted);
        if (recognition.stage === 'download' && recognition.reason === 'not-found') return fail(error, REPLIES.reelGone);
        return fail(error, REPLIES.reelFailed);
      }
      log.info('reel recognised', {
        mid,
        songs: recognition.songs.length,
        heard: recognition.heard.length,
        used: recognition.used,
        notes: recognition.notes,
        usage: recognition.usage ?? null,
      });
      songs =
        recognition.songs.length > 0
          ? recognition.songs.map(({ title, artist }) => ({ title, artist }))
          : recognition.heard.map(({ title, artist, track }) => ({
              title,
              artist,
              heard: true as const,
              ...(track ? { track } : {}),
            }));
      // An empty answer is not kept when fingerprinting broke down part-way:
      // the next send should listen again.
      const final = songs.length > 0 || !recognition.fingerprintFailed;
      if (shortcode !== null && final) store.saveReelSongs(shortcode, songs);
    }
    if (songs.length === 0) {
      store.setReelStatus(mid, 'done', { matched: [] });
      return reply(igsid, deps.fingerprinting ? REPLIES.noSongsHeard : REPLIES.noSongs, mid);
    }

    const inPlaylist = await session.call((token) => spotify.playlistUris(token, user.playlistId));
    if (!inPlaylist.ok) return spotifyFail(inPlaylist);

    const outcomes: SongOutcome[] = [];
    const toAdd: string[] = [];
    for (const song of songs) {
      let outcome: SongOutcome = { song, result: 'not-found' };
      // A fingerprinted song can come with its Spotify track, which is added as it is.
      if (song.track) {
        const known = inPlaylist.value.has(song.track.uri) || toAdd.includes(song.track.uri);
        if (!known) toAdd.push(song.track.uri);
        outcomes.push({ song, result: known ? 'already' : 'added', track: song.track, artistUnconfirmed: false });
        continue;
      }
      for (const query of searchQueries(song)) {
        const results = await session.call((token) => spotify.searchTracks(token, query));
        if (!results.ok) return spotifyFail(results);
        const match = pickTrack(song, results.value);
        if (!match.found) continue;
        const known = inPlaylist.value.has(match.track.uri) || toAdd.includes(match.track.uri);
        if (!known) toAdd.push(match.track.uri);
        outcome = {
          song,
          result: known ? 'already' : 'added',
          track: match.track,
          artistUnconfirmed: match.artistUnconfirmed,
        };
        break;
      }
      outcomes.push(outcome);
    }

    if (toAdd.length > 0) {
      const added = await session.call((token) => spotify.addToPlaylist(token, user.playlistId, toAdd));
      if (!added.ok) return spotifyFail(added);
    }

    store.setReelStatus(mid, 'done', { matched: outcomes });
    log.info('reel done', { mid, igsid, added: toAdd.length, songs: outcomes.length });
    await reply(igsid, formatReply(outcomes), mid);
  }

  return {
    /** Takes one parsed webhook event. Returns at once; the work happens in the background. */
    handle(event: InboundEvent): void {
      if (event.kind === 'ignored') return;
      const { mid, igsid } = event;

      if (event.kind === 'reel') {
        const fresh = store.claimMessage({
          mid,
          igsid,
          url: event.reel.url,
          caption: event.reel.title,
          status: 'queued',
        });
        if (!fresh) return log.info('duplicate delivery skipped', { mid });
        return enqueue('reel', () => processReel(mid));
      }

      // The bot's own replies can come back flagged as self messages. Answering
      // one would start a loop, so only a reel gets a reply in that conversation.
      if (event.isSelf) return;
      // Plain text gets no reply: a thank-you should not set the bot off.
      if (event.kind === 'message' && event.attachmentTypes.length === 0) return;

      if (!store.claimMessage({ mid, igsid, url: null, caption: null, status: 'answered' })) {
        return log.info('duplicate delivery skipped', { mid });
      }
      const text = event.kind === 'unsupported' ? REPLIES.unsupported : REPLIES.notAReel;
      enqueue('reply', () => reply(igsid, text, mid));
    },

    /** Called once someone has linked Spotify: confirms it and processes the reels that were waiting. */
    linked(igsid: string): void {
      enqueue('linked', () => reply(igsid, REPLIES.linked, null));
      for (const reel of store.pendingReels(igsid, now() - REPLY_WINDOW_MS)) {
        store.setReelStatus(reel.mid, 'queued');
        enqueue('reel', () => processReel(reel.mid));
      }
    },

    /**
     * Run at startup. Meta does not redeliver a webhook that was acknowledged,
     * so reels cut off by a restart are closed and their senders asked to resend.
     */
    recover(): void {
      for (const reel of store.interruptedReels()) {
        store.setReelStatus(reel.mid, 'failed', { error: 'interrupted by a restart' });
        log.warn('reel interrupted by a restart', { mid: reel.mid, igsid: reel.igsid });
        if (now() - reel.createdAt <= REPLY_WINDOW_MS) {
          enqueue('reply', () => reply(reel.igsid, REPLIES.interrupted, reel.mid));
        }
      }
    },

    /** Resolves when everything accepted so far has been processed. */
    idle(): Promise<void> {
      return tail;
    },
  };
}

/**
 * The DM for a processed reel. Added songs are shown with the track and artist
 * names Spotify has, not the reel's, so a wrong match is visible. Songs that
 * were identified from the music, not named, are marked "heard in the reel".
 */
export function formatReply(outcomes: SongOutcome[]): string {
  const describe = (track: Track) => (track.artists.length > 0 ? `${track.name} by ${track.artists.join(', ')}` : track.name);
  type Matched = Extract<SongOutcome, { track: Track }>;
  const withResult = (result: Matched['result']) =>
    outcomes.filter((outcome): outcome is Matched => outcome.result === result);
  const added = withResult('added');
  const already = withResult('already');
  const missing = outcomes.filter((outcome) => outcome.result === 'not-found');
  const heard = (song: ReelSong) => (song.heard ? ' (heard in the reel)' : '');
  const line = (outcome: Matched) =>
    describe(outcome.track) +
    heard(outcome.song) +
    (outcome.artistUnconfirmed ? ' (the reel gave no artist, so check this one)' : '');

  if (added.length === 1 && outcomes.length === 1) return `Snagged: ${line(added[0]!)}`;

  const sections: string[] = [];
  const section = (heading: string, lines: string[]) => {
    if (lines.length > 0) sections.push([heading, ...lines.map((text) => `• ${text}`)].join('\n'));
  };
  section(`Snagged ${added.length} ${added.length === 1 ? 'song' : 'songs'}:`, added.map(line));
  section('Already in your playlist:', already.map(line));
  section(
    "Couldn't find on Spotify:",
    missing.map(({ song }) => (song.artist === null ? song.title : `${song.title} by ${song.artist}`) + heard(song)),
  );
  return sections.join('\n\n');
}
