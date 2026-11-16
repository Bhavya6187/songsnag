/**
 * The public pages: a landing page plus the privacy policy, terms and
 * data-deletion instructions that Meta and Spotify ask for before an app can
 * be published.
 *
 * Everything is inline (no scripts, fonts, cookies or third-party requests),
 * which is also what the privacy policy says.
 */

export type SiteConfig = {
  /** The SongSnag account's Instagram handle without the @, or null if not set. */
  igHandle: string | null;
  /** Address for privacy and deletion requests, or null if not set. */
  contactEmail: string | null;
};

export type SitePage = 'home' | 'privacy' | 'terms' | 'data-deletion';

/** Shown on the legal pages. Change it whenever their wording changes. */
const LAST_UPDATED = '15 November 2026';

const DELETION_DAYS = 30;

export function renderPage(page: SitePage, site: SiteConfig): string {
  switch (page) {
    case 'home':
      return layout({
        title: 'SongSnag',
        description: 'Send a reel to SongSnag and the song in it lands in your playlist.',
        body: home(site),
      });
    case 'privacy':
      return layout({
        title: 'Privacy Policy · SongSnag',
        description: 'What SongSnag collects, why, and how to have it deleted.',
        body: privacy(site),
      });
    case 'terms':
      return layout({
        title: 'Terms of Service · SongSnag',
        description: 'The terms for using SongSnag.',
        body: terms(site),
      });
    case 'data-deletion':
      return layout({
        title: 'Delete your data · SongSnag',
        description: 'How to have your SongSnag data deleted.',
        body: dataDeletion(site),
      });
  }
}

export function renderNotFound(): string {
  return layout({
    title: 'Not found · SongSnag',
    description: 'This page does not exist.',
    body: `<h1>Nothing here</h1><p>That page does not exist. <a href="/">Back to SongSnag</a>.</p>`,
  });
}

export type LinkPage = 'linked' | 'expired' | 'declined' | 'not-invited' | 'failed';

/** What someone sees in the browser at the end of (or instead of) the Spotify sign-in. */
export function renderLinkPage(page: LinkPage): string {
  const pages: Record<LinkPage, { heading: string; text: string }> = {
    linked: {
      heading: 'You’re linked',
      text: 'SongSnag made a private playlist called “SongSnag” in your Spotify account. Songs from the reels you send go there. You can close this page and go back to your messages.',
    },
    expired: {
      heading: 'This link no longer works',
      text: 'Links work once and last an hour. Send a reel to the SongSnag account again and it will reply with a new one.',
    },
    declined: {
      heading: 'Not linked',
      text: 'You did not give SongSnag access, so nothing was linked. If you change your mind, open the link from your messages again.',
    },
    'not-invited': {
      heading: 'Spotify said no',
      text: 'SongSnag is invite-only, and your Spotify account is not on its list yet. Ask whoever invited you to add the email address of your Spotify account, then open the link from your messages again.',
    },
    failed: {
      heading: 'Something went wrong',
      text: 'The link with Spotify could not be completed. Open the link from your messages again in a few minutes.',
    },
  };
  const { heading, text } = pages[page];
  return layout({
    title: `${heading} · SongSnag`,
    description: 'Linking Spotify to SongSnag.',
    body: `<h1>${heading}</h1><p class="lede">${text}</p>`,
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** "the SongSnag account on Instagram", linked and with the handle when it is known. */
function accountRef(site: SiteConfig): string {
  if (site.igHandle === null) return 'the SongSnag account on Instagram';
  const handle = escapeHtml(site.igHandle);
  return `the SongSnag account on Instagram (<a href="https://www.instagram.com/${encodeURIComponent(site.igHandle)}/">@${handle}</a>)`;
}

/** A sentence fragment listing every way to reach us. */
function contactWays(site: SiteConfig): string {
  const dm = `send a message to ${accountRef(site)}`;
  if (site.contactEmail === null) return dm;
  const email = escapeHtml(site.contactEmail);
  return `email <a href="mailto:${email}">${email}</a> or ${dm}`;
}

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23161412'/%3E%3Cpath d='M26 44V18l20-5v24' fill='none' stroke='%23ff6a3d' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='20' cy='44' r='7' fill='%23ff6a3d'/%3E%3Ccircle cx='40' cy='38' r='7' fill='%23ff6a3d'/%3E%3C/svg%3E";

const STYLE = `
:root{--bg:#faf6ef;--ink:#161412;--muted:#6b645b;--line:#e4dccf;--accent:#d8431a;--card:#fffdf9}
@media (prefers-color-scheme:dark){:root{--bg:#141210;--ink:#f3ede4;--muted:#a59c90;--line:#2e2a25;--accent:#ff7a4d;--card:#1b1815}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:680px;margin:0 auto;padding:0 20px}
header{padding:28px 0 0}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:18px;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
.brand img{width:28px;height:28px;display:block}
main{padding:48px 0 64px}
h1{font-size:clamp(34px,7vw,52px);line-height:1.08;letter-spacing:-.03em;margin:0 0 18px;text-wrap:balance}
.legal h1{font-size:clamp(30px,6vw,40px)}
h2{font-size:21px;letter-spacing:-.01em;margin:44px 0 10px}
p,ul,ol{margin:0 0 16px}
ul,ol{padding-left:22px}
li{margin-bottom:8px}
a{color:var(--accent);text-underline-offset:3px}
.lede{font-size:20px;color:var(--muted);max-width:34em}
.meta{color:var(--muted);font-size:15px}
.steps{list-style:none;padding:0;margin:40px 0 0;counter-reset:step;display:grid;gap:12px}
.steps li{counter-increment:step;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px 18px 62px;position:relative;margin:0}
.steps li::before{content:counter(step);position:absolute;left:20px;top:18px;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;font-size:15px;display:grid;place-items:center}
.steps strong{display:block}
.steps span{color:var(--muted)}
.note{margin-top:32px;padding:16px 20px;border-left:3px solid var(--accent);background:var(--card);border-radius:0 10px 10px 0}
footer{border-top:1px solid var(--line);padding:24px 0 48px;color:var(--muted);font-size:15px}
footer nav{display:flex;flex-wrap:wrap;gap:6px 20px;margin-bottom:10px}
footer a{color:var(--muted)}
`;

function layout(page: { title: string; description: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="icon" href="${ICON}">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<header><a class="brand" href="/"><img src="${ICON}" alt="">SongSnag</a></header>
<main>
${page.body}
</main>
<footer>
<nav><a href="/">Home</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/data-deletion">Delete your data</a></nav>
<div>SongSnag is an independent project. It is not affiliated with, endorsed by or sponsored by Meta, Instagram or Spotify.</div>
</footer>
</div>
</body>
</html>
`;
}

function home(site: SiteConfig): string {
  return `<h1>Hear it in a reel. Find it in your playlist.</h1>
<p class="lede">Send a reel to SongSnag in a direct message. SongSnag finds the songs the reel names, in its caption, on screen or out loud, adds them to your Spotify playlist and replies with what it found.</p>
<ol class="steps">
<li><strong>Share a reel</strong><span>Send it as a direct message to ${accountRef(site)}.</span></li>
<li><strong>Link Spotify once</strong><span>The first time, SongSnag replies with a link to connect your Spotify account. It creates a private playlist called “SongSnag”.</span></li>
<li><strong>Get the songs</strong><span>SongSnag adds each track to that playlist and replies “Snagged: track by artist”, so a wrong match is easy to see.</span></li>
</ol>
<p class="note">SongSnag is a small, invite-only project for now. If you have not been invited, messages to the account will not get a reply.</p>`;
}

function privacy(site: SiteConfig): string {
  return `<div class="legal">
<h1>Privacy Policy</h1>
<p class="meta">Last updated ${LAST_UPDATED}</p>
<p>SongSnag is a small, invite-only service run by an individual. You send a reel to ${accountRef(site)} in a direct message, and SongSnag adds the songs it names to your Spotify playlist. This policy explains what information SongSnag handles to do that.</p>

<h2>What we collect</h2>
<p><strong>When you message the SongSnag account.</strong> Meta sends us the message. From it we keep:</p>
<ul>
<li>your Instagram-scoped user ID, a number that identifies you to our account. It is not your username or password, and we cannot use it to sign in as you;</li>
<li>the message’s ID and time;</li>
<li>for a reel: the link to the reel, its caption and its video ID.</li>
</ul>
<p>Meta delivers every message you send to the account, including text. SongSnag only acts on reels and does not store the text of other messages.</p>
<p><strong>When you link Spotify.</strong> You sign in on Spotify’s own site; we never see your Spotify password. We keep:</p>
<ul>
<li>the access and refresh tokens Spotify issues, stored encrypted;</li>
<li>your Spotify user ID, so that linking again reuses the same playlist;</li>
<li>the ID of the “SongSnag” playlist created in your account.</li>
</ul>
<p>We ask Spotify only for permission to create and change playlists and to see your private playlists. We use it only to create the SongSnag playlist, to check which songs are already in it, and to add songs to it. We do not look at your other playlists.</p>
<p><strong>For each reel you send.</strong> We keep a record of the song that was matched, whether it was added, and any error, so the same reel is not processed twice and so problems can be fixed.</p>
<p><strong>Server logs.</strong> Our server logs the IDs above along with technical details of each request. Our hosting provider may log the IP addresses of visitors to this website.</p>
<p>This website uses no cookies, analytics or advertising trackers.</p>

<h2>How we use it</h2>
<p>Only to run the service: to find the songs in a reel you send, add them to your playlist, reply to you, and keep the service working. We do not use your information for advertising or profiling, and we do not sell it.</p>

<h2>Who it is shared with</h2>
<ul>
<li><strong>Anthropic</strong>, whose Claude model reads the reel’s caption, still images from its video and a transcript of its speech to find the songs it names. We do not send it your user ID.</li>
<li><strong>OpenAI</strong>, whose transcription service turns the speech in the reel’s audio into text. We send it the reel’s audio and caption, not your user ID.</li>
<li><strong>AudD</strong>, whose music recognition service identifies the music playing in a reel when the reel does not name a song. We send it short clips of the reel’s audio, not your user ID.</li>
<li><strong>Spotify</strong>, to find the track and add it to your playlist.</li>
<li><strong>Meta</strong>, to deliver our replies to you through Instagram messaging.</li>
<li><strong>Our hosting provider</strong>, which runs the server and stores its database.</li>
</ul>
<p>We do not share your information with anyone else, unless the law requires it.</p>

<h2>How long we keep it</h2>
<p>To find the songs, SongSnag downloads the reel from its public page. The video, the images and the audio taken from it are deleted as soon as the reel has been processed. Your IDs, Spotify tokens and the record of your reels are kept until you ask us to delete them or SongSnag shuts down. Server logs are kept for a limited time.</p>

<h2>Your choices</h2>
<ul>
<li><strong>Delete your data.</strong> See <a href="/data-deletion">Delete your data</a>. We delete it within ${DELETION_DAYS} days of your request.</li>
<li><strong>Disconnect Spotify.</strong> In your Spotify account, open Manage apps and remove SongSnag. This stops SongSnag from reaching your account at once.</li>
<li><strong>Ask what we hold.</strong> Contact us and we will tell you what information we have about you, or correct it.</li>
<li><strong>Stop using it.</strong> If you stop messaging the account, SongSnag receives nothing further about you.</li>
</ul>

<h2>Security</h2>
<p>Spotify tokens are encrypted before they are stored. The website and all connections to the services above use HTTPS, and we check that every incoming message really comes from Meta. No system is perfectly secure, but we keep as little as we can.</p>

<h2>Children</h2>
<p>SongSnag is not meant for children under 13, and we do not knowingly collect information from them.</p>

<h2>Changes</h2>
<p>If this policy changes, the new version will be posted on this page with a new date.</p>

<h2>Contact</h2>
<p>For any question about this policy or your information, ${contactWays(site)}.</p>
</div>`;
}

function terms(site: SiteConfig): string {
  return `<div class="legal">
<h1>Terms of Service</h1>
<p class="meta">Last updated ${LAST_UPDATED}</p>
<p>These terms apply when you use SongSnag. By sending a message to ${accountRef(site)} or linking your Spotify account, you agree to them.</p>

<h2>The service</h2>
<p>SongSnag finds the songs named in a reel you send and adds them to a playlist in your Spotify account. It is a small, invite-only project run by an individual, free of charge. It can only be used by people who have been invited.</p>

<h2>What to expect</h2>
<ul>
<li>Matches can be wrong or missing, and a song that only plays in the reel, without being named, may be missed or misidentified. SongSnag tells you which tracks it added so you can check.</li>
<li>The service is provided as it is, with no guarantee that it will be available, accurate or free of errors.</li>
<li>It may change, pause or shut down at any time, and access may be withdrawn from anyone at any time.</li>
</ul>

<h2>Your part</h2>
<ul>
<li>Use SongSnag only with your own Instagram and Spotify accounts, and follow Instagram’s and Spotify’s own terms when you do.</li>
<li>Do not try to disrupt the service, get around its limits, or use it to send spam or automated traffic.</li>
</ul>

<h2>Your information</h2>
<p>The <a href="/privacy">Privacy Policy</a> explains what SongSnag collects and how to have it deleted.</p>

<h2>Other companies</h2>
<p>SongSnag is an independent project. It is not affiliated with, endorsed by or sponsored by Meta, Instagram or Spotify. Their names belong to their owners. Songs, reels and playlists remain subject to those services’ terms.</p>

<h2>Liability</h2>
<p>To the extent the law allows, SongSnag and the person who runs it are not liable for any loss arising from your use of the service, including a wrong song being added to a playlist.</p>

<h2>Changes</h2>
<p>If these terms change, the new version will be posted on this page with a new date. Using SongSnag after that means you accept the new terms.</p>

<h2>Contact</h2>
<p>For any question about these terms, ${contactWays(site)}.</p>
</div>`;
}

function dataDeletion(site: SiteConfig): string {
  return `<div class="legal">
<h1>Delete your data</h1>
<p class="meta">Last updated ${LAST_UPDATED}</p>
<p>You can have everything SongSnag holds about you deleted at any time.</p>

<h2>How to ask</h2>
<p>To request deletion, ${contactWays(site)}, and say that you want your SongSnag data deleted. If you write by email, include your Instagram username so we can find your record.</p>

<h2>What is deleted</h2>
<ul>
<li>your Instagram-scoped user ID;</li>
<li>your Spotify access and refresh tokens, your Spotify user ID and the stored playlist ID;</li>
<li>the record of the reels you sent and the songs matched to them.</li>
</ul>
<p>We delete these within ${DELETION_DAYS} days and confirm when it is done. Entries in server logs expire on their own shortly afterwards.</p>

<h2>What stays in your own accounts</h2>
<ul>
<li>The “SongSnag” playlist and its songs are in your Spotify account and are yours. Delete the playlist in Spotify if you no longer want it.</li>
<li>Your messages to the account remain in your Instagram inbox until you delete them there.</li>
</ul>

<h2>Disconnect Spotify yourself</h2>
<p>You can cut off SongSnag’s access to your Spotify account right away, without waiting for us: in your Spotify account, open Manage apps and remove SongSnag.</p>

<p>See the <a href="/privacy">Privacy Policy</a> for more about what SongSnag collects.</p>
</div>`;
}
