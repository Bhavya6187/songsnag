import type { Store } from './db.ts';
import type { Logger } from './log.ts';
import type { Spotify } from './spotify/client.ts';

/**
 * The second half of linking: Spotify has sent the person back with a code.
 * Exchange it, make sure they have a "SongSnag" playlist, and store the link.
 */

export const PLAYLIST_NAME = 'SongSnag';
const PLAYLIST_DESCRIPTION = 'Songs from the reels you sent to SongSnag.';

export type LinkOutcome =
  | { result: 'linked'; igsid: string }
  /** The link was used already, expired, or never existed. */
  | { result: 'expired' }
  /** Spotify refused the account: it is not on the app's user list. */
  | { result: 'not-invited' }
  | { result: 'failed' };

export async function completeLink(
  deps: { store: Store; spotify: Spotify; log: Logger; now?: () => number },
  input: { state: string; code: string },
): Promise<LinkOutcome> {
  const { store, spotify, log } = deps;
  const now = deps.now ?? Date.now;

  // Used up before the exchange so two requests cannot both link with it.
  const igsid = store.consumeLinkToken(input.state);
  if (igsid === null) return { result: 'expired' };

  // A failure from here on is not the person's doing, so the link is made usable again.
  const giveUp = (result: 'not-invited' | 'failed', detail: string): LinkOutcome => {
    store.restoreLinkToken(input.state);
    log.warn('linking failed', { igsid, result, detail });
    return { result };
  };

  const exchange = await spotify.exchangeCode(input.code);
  if (!exchange.ok) return giveUp('failed', exchange.detail);
  const { accessToken, refreshToken, expiresInSeconds } = exchange.tokens;
  if (refreshToken === null) return giveUp('failed', 'no refresh token in the response');

  const spotifyUser = await spotify.currentUserId(accessToken);
  if (!spotifyUser.ok) {
    return giveUp(spotifyUser.reason === 'forbidden' ? 'not-invited' : 'failed', spotifyUser.detail);
  }

  // Linking again with the same Spotify account keeps the playlist it already has.
  const existing = store.getUser(igsid);
  let playlistId = existing?.spotifyUserId === spotifyUser.value ? existing.playlistId : null;
  if (playlistId === null) {
    const playlist = await spotify.createPlaylist(accessToken, {
      name: PLAYLIST_NAME,
      description: PLAYLIST_DESCRIPTION,
    });
    if (!playlist.ok) {
      return giveUp(playlist.reason === 'forbidden' ? 'not-invited' : 'failed', playlist.detail);
    }
    playlistId = playlist.value;
  }

  store.saveUser({
    igsid,
    spotifyUserId: spotifyUser.value,
    accessToken,
    refreshToken,
    accessExpiresAt: now() + expiresInSeconds * 1000,
    playlistId,
  });
  log.info('spotify linked', { igsid, newPlaylist: existing?.playlistId !== playlistId });
  return { result: 'linked', igsid };
}
