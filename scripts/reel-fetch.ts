/**
 * Downloads one reel from its public page, to try the download step by hand.
 *
 *   npm run reel:fetch -- https://www.instagram.com/reel/<shortcode>/
 *
 * The video is written to captures/reels/, which git ignores.
 */
import { downloadReel } from '../src/reel/download.ts';

const url = process.argv[2];
if (!url) {
  console.error('Usage: npm run reel:fetch -- <reel URL>');
  process.exit(1);
}

const result = await downloadReel(url, { dir: 'captures/reels' });
if (result.ok) {
  console.log(`Downloaded ${result.path} (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`);
} else {
  console.error(`Could not download (${result.reason}): ${result.detail}`);
  process.exit(1);
}
