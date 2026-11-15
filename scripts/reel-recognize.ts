/**
 * Runs the whole recognition step on one reel and prints the songs it names.
 *
 *   npm run reel:recognize -- https://www.instagram.com/reel/<shortcode>/ ["caption text"]
 *
 * Needs yt-dlp and ffmpeg installed, ANTHROPIC_API_KEY, and OPENAI_API_KEY for
 * speech. Each run makes paid API calls (a fraction of a cent to a few cents).
 */
import { recognizeReel } from '../src/recognize/reel.ts';

const [url, caption] = process.argv.slice(2);
if (!url) {
  console.error('Usage: npm run reel:recognize -- <reel URL> ["caption text"]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error('ANTHROPIC_API_KEY is not set. See .env.example.');
  process.exit(1);
}

const result = await recognizeReel(
  { url, caption: caption ?? null },
  { openaiApiKey: process.env.OPENAI_API_KEY?.trim() || null },
);

if (!result.ok) {
  console.error(`Failed at ${result.stage} (${result.reason}): ${result.detail}`);
  process.exit(1);
}

console.log(
  `Read: caption ${result.used.caption ? 'yes' : 'no'}, ${result.used.frames} frames, speech ${result.used.transcript ? 'yes' : 'no'}`,
);
if (result.usage) {
  console.log(`Claude (${result.usage.model}): ${result.usage.inputTokens} input tokens, ${result.usage.outputTokens} output tokens`);
}
for (const note of result.notes) console.log(`Note: ${note}`);
if (result.songs.length === 0) console.log('No songs named in this reel.');
for (const [index, song] of result.songs.entries()) {
  console.log(
    `${index + 1}. ${song.title} by ${song.artist ?? '(artist not given)'}  [${song.sources.join(', ')}; ${song.confidence}]`,
  );
}
