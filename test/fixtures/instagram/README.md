# Instagram webhook fixtures

Files named `doc-*.json` are hand-built from the payload shapes in Meta's
webhook documentation. They are not recordings.

Once a real delivery has been captured (see `CAPTURE_DIR` in `.env.example`),
add it here as `recorded-*.json` with the IDs, message IDs and CDN URL
signature replaced by placeholders, and point the tests at it.

`recorded-reel.json` is a real reel share received on 2026-11-14, with the
account ID, sender ID, message ID, video ID, reel shortcode and caption
replaced by placeholders. Its `url` is the reel's public page
(`https://www.instagram.com/reel/<shortcode>/`), not a video file on Meta's
CDN as the documentation describes, and its `reel_video_id` is a string.
