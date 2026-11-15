# SongSnag

DM a reel to the SongSnag Instagram account and the songs it names are added to
your Spotify playlist. The bot replies in the DM with the tracks it matched.

This is a private prototype for up to five people.

## Status

Everything in the flow is built: the webhook, song recognition, Spotify
linking, adding to the playlist, and the DM replies. The Spotify calls and the
DM replies are written from the two platforms' documentation and covered by
tests against stand-ins; they have not yet been run against a real Spotify app
or sent a real DM.

| Route | Purpose |
| --- | --- |
| `GET /` | Landing page |
| `GET /privacy` | Privacy Policy |
| `GET /terms` | Terms of Service |
| `GET /data-deletion` | Data deletion instructions |
| `GET /webhook/instagram` | Verification handshake |
| `POST /webhook/instagram` | Receives DM events, acknowledges, processes in the background |
| `GET /link/:token` | One-time link from a DM; redirects to Spotify's sign-in |
| `GET /auth/spotify/callback` | Where Spotify sends the person back; stores the link |
| `GET /healthz` | Liveness check |

The last two exist only when the service is on. The server starts with just
`META_APP_SECRET` and `META_VERIFY_TOKEN`, and in that state it verifies and
logs webhooks and serves the website but answers nobody. The service switches
on when `IG_ACCESS_TOKEN`, `IG_ACCOUNT_ID`, `SPOTIFY_CLIENT_ID`,
`SPOTIFY_CLIENT_SECRET`, `BASE_URL`, `TOKEN_ENCRYPTION_KEY` and
`ANTHROPIC_API_KEY` are all set. The first log line at startup says which are
missing.

## What happens to a reel

1. Meta delivers the DM. The signature is checked, the message is recorded by
   its ID, and Meta gets its answer straight away. A delivery whose message ID
   is already recorded is one of Meta's retries and is skipped.
2. If the sender has not linked Spotify, they get a DM with a link
   (`<BASE_URL>/link/<token>`) that works once and lasts an hour. It takes
   them to Spotify's sign-in. When they come back, SongSnag creates a private
   playlist called "SongSnag" in their account, stores their tokens encrypted,
   and processes the reels that were waiting.
3. The reel is downloaded and read (see "Recognising the songs in a reel").
   The songs it names are kept in the database by the reel's shortcode
   (table `reel_songs`), so the same reel sent again, by anyone, skips this
   step. Only a successful read is kept, including one that found no songs.
   To have a reel read afresh, delete its row.
4. Each song is searched on Spotify and added unless it is already in the
   playlist. All new songs from one reel go in one request.
5. The sender gets one DM listing what was added, what was already there and
   what could not be found.

Reels are processed one at a time. A reel that was being processed when the
server restarted is closed, and its sender is asked to send it again.

### Which search result counts as the song

Recognition gives a title and sometimes an artist, never a Spotify ID, and a
search always returns something. A wrong add is worse than a miss, so
(`src/spotify/match.ts`):

- With an artist: the track's title must match, ignoring case, accents and
  decorations such as "(feat. X)" or "- Remastered 2011", with a little room
  for a misspelling, and one of the track's artists must match.
- Without an artist: the title must match exactly. The reply marks the song
  "the reel gave no artist, so check this one".
- Anything else is reported as not found, and nothing is added for it.

The reply uses the track and artist names Spotify has, not the reel's, so a
wrong match shows.

### What the replies look like

```
Snagged: Khushi by Nazia Hassan, Zoheb Hassan
```

```
Snagged 2 songs:
• Track One by Artist
• Track Two by Artist

Already in your playlist:
• Track Three by Artist

Couldn't find on Spotify:
• Track Four by Artist
```

Every failure gets a short DM too: a reel that is private or gone, a reel that
names no song, a share Instagram could not deliver, something other than a
reel, Spotify refusing or being down. The texts are in `REPLIES` in
`src/pipeline.ts`. Plain text messages get no reply.

## Requirements

- Node 24 or newer. Node runs the TypeScript sources directly, so there is no
  build step.
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
  for a public URL in local development (`brew install cloudflared`).

## Run it locally

```sh
npm install
cp .env.example .env    # then fill it in; the comments say what each value is
npm run dev             # server on http://localhost:3000, restarts on changes
npm run tunnel          # in a second terminal; prints a public https URL
```

`npm run dev` also restarts when `.env` changes. The tunnel URL is different
every time `npm run tunnel` starts; when it changes, update the callback URL in
the Meta App Dashboard.

```sh
npm test                # unit and route tests, no network
npm run typecheck
```

## Meta app setup

SongSnag uses Meta's **Instagram API with Unified Login**. Meta no longer lets
newly created apps use the older "Instagram API with Instagram Login" setup.
Unified Login also needs no Facebook Page. Its API host is `graph.facebook.com`
and its credentials are the Meta app ID and app secret.

These steps follow Meta's documentation as of November 2026. Dashboard wording
changes often, so labels may differ slightly.

1. **Instagram account.** Create the SongSnag account and switch it to a
   professional account (Business or Creator). In the Instagram app's message
   settings, turn on **Allow access to messages**. Messaging calls fail while
   it is off.
2. **Business portfolio.** The app must be owned by a business portfolio, or
   the Unified Login tab does not appear. Create one at
   <https://business.facebook.com> if you do not have one.
3. **Meta app.** At <https://developers.facebook.com/apps> create an app with
   the **Manage messaging & content on Instagram** use case, owned by that
   portfolio.
4. **App secret.** Copy **App secret** from App settings > Basic into
   `META_APP_SECRET`.
5. **Configuration.** Open Use cases > Manage messaging & content on Instagram
   > Customize > **API setup with Unified login**. Under "Configure your app",
   choose Create new configuration. Use Edit permissions to keep only
   `instagram_basic` and `instagram_manage_messages`. Enter an HTTPS redirect
   URL you control (the eventual `BASE_URL` is fine) and save.
6. **Access token.** Under "Generate access tokens", add the SongSnag account
   as an Instagram Tester. Accept the invitation in Instagram on the web:
   Settings > Website permissions > Apps and websites > Tester Invites. Then
   choose Generate token and put it in `IG_ACCESS_TOKEN`. It is shown once.
7. **Webhook.** With `npm run dev` and `npm run tunnel` running, open
   "Configure webhooks" and enter:
   - Callback URL: `https://<your-tunnel-host>/webhook/instagram`
   - Verify token: the value of `META_VERIFY_TOKEN`

   Saving makes Meta call the server, which logs `webhook verification
   succeeded`. Subscribe to the `messages` field.
8. **Subscribe the account.** Run `npm run ig:subscribe`. It enables `messages`
   webhooks for the account and prints the `IG_ACCOUNT_ID` to put in `.env`.
9. **Testers.** While the app is in Development mode, only people with a role
   on the app can use it. Add each person's Instagram account as an Instagram
   Tester (same place as step 6); they accept the same way.

### Capture a real reel DM

With `CAPTURE_DIR=captures` set, every verified webhook body is written to
`captures/` exactly as Meta sent it. That directory is ignored by git because
the files hold real user IDs and signed media URLs.

1. In the webhook settings, use **Test** on the `messages` field. The server
   should log `webhook received`. This proves the callback URL and the app
   secret are right.
2. From a tester account, share a reel to the SongSnag account in a DM. The
   server should log `reel received` with the reel's `title`, `videoId` and
   `url`.

If the server logs `signature check failed` with reason `mismatch`,
`META_APP_SECRET` is not the secret of the app that sent the webhook.

If the test in step 1 arrives but a real DM does not:

- Check that the sender accepted the tester invitation and that step 8
  succeeded.
- Try a self message: logged in as the SongSnag account, share a reel to
  yourself. Meta documents this as a test path; it arrives with `is_self`.
- Check the app mode. Meta's Unified Login guide says Development mode is
  enough for people with a role on the app, but its general webhook setup
  guide says an app must be Live to receive notifications. If Development
  mode delivers nothing, switching the app to Live is the next thing to try.

## Spotify app setup

SongSnag uses Spotify's Authorization Code flow. A new Spotify app is in
Development Mode: the owner needs Spotify Premium, and only people on the
app's user list can use it, five at most.

1. At <https://developer.spotify.com/dashboard> choose **Create app**. Name it
   "SongSnag", tick **Web API**, and add this redirect URI, exactly, with no
   trailing slash: `https://api.songsnag.com/auth/spotify/callback` (for local
   work, `<your BASE_URL>/auth/spotify/callback` as well).
2. From the app's settings, copy **Client ID** and **Client secret** into
   `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
3. Under **User Management**, add the name and Spotify email address of each
   person who will use SongSnag, yourself included. Someone who is not on the
   list gets as far as Spotify's sign-in and is then refused; SongSnag tells
   them to ask to be added.
4. Generate the key that encrypts the stored tokens and put it in
   `TOKEN_ENCRYPTION_KEY`: `openssl rand -base64 32`. Keep it: without it the
   stored tokens cannot be read and everyone has to link again.

SongSnag asks for three permissions: `playlist-modify-private` and
`playlist-modify-public` to create the playlist and add to it, and
`playlist-read-private` to see what is already in it, which is how duplicates
are skipped. It reads no playlist but its own.

Spotify's refresh tokens last six months from the day a person links. When
one stops working, their next reel gets a new link instead of an error, and
the reel is processed once they have linked again.

The calls follow Spotify's reference after its February 2026 changes
(`POST /me/playlists`, `/playlists/{id}/items`, search limited to 10
results). They are all in `src/spotify/client.ts`.

## Deploy

SongSnag runs on Railway from the `Dockerfile`: project `songsnag`, service
`songsnag`, with `api.songsnag.com` and `www.songsnag.com` pointing at it.

```sh
railway up --service songsnag --ci
```

The service needs:

- **A volume mounted at `/data`.** The SQLite database is `/data/songsnag.db`.
  Without a volume it is lost on every deploy and everyone has to link again.
  Railway mounts volumes as root while the image runs as `node`, so also set
  `RAILWAY_RUN_UID=0` on the service, or the server cannot write to it.
- **Variables**: everything in `.env.example` except `CAPTURE_DIR`, `PORT`
  and `DATABASE_PATH`. `BASE_URL` is `https://api.songsnag.com`. Setting a
  variable redeploys the service.

After a deploy, `railway logs --service songsnag` should show `SongSnag
listening` with `"service":true`.

To delete one person's data, as the privacy policy promises:

```sh
railway ssh --service songsnag
node scripts/user-delete.ts <IGSID>     # the igsid from that person's log lines
```

## Website and publishing the app

The pages are in `src/site.ts`. They show the account handle from `IG_HANDLE`
and a contact address from `CONTACT_EMAIL`; with neither set they tell people
to message the SongSnag account. The privacy policy describes the finished
service. Read it before publishing,
and update it (and its "Last updated" date) if the service comes to work
differently.

To switch the Meta app to Live, fill these in under App settings > Basic,
replacing the host with wherever the site is deployed:

| Dashboard field | Value |
| --- | --- |
| Privacy Policy URL | `https://www.songsnag.com/privacy` |
| Terms of Service URL | `https://www.songsnag.com/terms` |
| User data deletion | Data deletion instructions URL: `https://www.songsnag.com/data-deletion` |
| App icon (1024 x 1024) | `assets/app-icon.png` |
| App domains | `songsnag.com` |

Meta fetches the privacy URL when you save, so the site has to be deployed
first.

The `Dockerfile` builds an image that runs the server on `PORT` (default
3000) and reads its configuration from environment variables.

## Recognising the songs in a reel

Meta's webhook delivers a shared reel as a link to its public page, not as a
video file, and its API has no route to the media. So SongSnag downloads the
reel itself and reads three things from it:

| Source | How |
| --- | --- |
| Caption | The `title` field of the webhook |
| On-screen text | ffmpeg takes about one frame a second (30 at most); Claude reads them |
| Speech | ffmpeg extracts the audio; OpenAI's `gpt-transcribe` turns it into text |

Claude (`claude-opus-5-5`) then gets the caption, the frames and the
transcript in one request and returns every song the reel names. Nothing
listens to the music itself: a song that plays without being named in any of
the three sources is not found.

The code is in `src/reel/` (download, frames, audio) and `src/recognize/`
(transcription, song extraction, and `reel.ts`, which runs the whole step).
The scripts below run it on its own, without the webhook or Spotify.

```sh
brew install yt-dlp ffmpeg
npm run reel:fetch -- https://www.instagram.com/reel/<shortcode>/
npm run reel:recognize -- https://www.instagram.com/reel/<shortcode>/ "caption text"
```

`reel:recognize` needs `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` for speech;
without the OpenAI key it reads the caption and frames only. Each run makes
paid API calls.

Downloads use [yt-dlp](https://github.com/yt-dlp/yt-dlp) anonymously (no
login, no cookies). Reels that Instagram only shows to logged-in viewers fail
with reason `restricted`. The Docker image installs a pinned yt-dlp and
ffmpeg; when every download starts failing, raise `YT_DLP_VERSION` in the
`Dockerfile` first.

## What the parser expects

From Meta's docs, checked against a real reel share captured on 2026-11-14:

- A reel share is a `message` with an attachment of type `ig_reel` whose
  `payload` has `url`, `title` (the caption) and `reel_video_id`. Meta's docs
  imply `url` is a video file on its CDN; in real deliveries it is the reel's
  public page, `https://www.instagram.com/reel/<shortcode>/`.
- A share Meta cannot deliver arrives as `message.is_unsupported: true` with no
  usable attachment. A reel attachment without a `url` is treated the same way.
- Messages the account itself sends come back as echoes (`is_echo`) and are
  ignored.
- Events arrive under `entry[].messaging[]`. The dashboard's Test button wraps
  them as `entry[].changes[].value` instead. Both are handled.
- The signature header is `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256
  of the raw request body keyed with the app secret.

The fixtures in `test/fixtures/instagram/` named `doc-*.json` are built from
those documented shapes. They are not recordings.
