import type { Track } from './client.ts';

/**
 * Decides which search result, if any, is the song a reel named.
 *
 * Recognition gives a title and sometimes an artist, never a Spotify ID, and
 * Spotify's search always returns something. Adding the wrong track is worse
 * than adding nothing, so a result is only accepted when it agrees with what
 * the reel said:
 *
 * - With an artist: the title must match (exactly, or nearly, to allow for a
 *   misheard or restyled spelling) and one of the track's artists must match.
 * - Without an artist: the title must match exactly, and the match is marked
 *   `artistUnconfirmed` so the reply can say so.
 *
 * Anything else is a miss, and the person is told the song was not found.
 */

export type WantedSong = { title: string; artist: string | null };

export type Match =
  | { found: true; track: Track; artistUnconfirmed: boolean }
  | { found: false };

/** How alike two near-identical spellings must be (1 is identical). */
const NEAR = 0.85;

export function searchQueries(song: WantedSong): string[] {
  if (song.artist === null) return [song.title];
  // Plain words first: field filters are strict about spelling, so they are the fallback.
  return [`${song.title} ${song.artist}`, `track:${song.title} artist:${song.artist}`];
}

export function pickTrack(song: WantedSong, results: Track[]): Match {
  let best: { track: Track; score: number } | null = null;
  for (const track of results) {
    const score = titleScore(song.title, track.name);
    if (score === 0) continue;
    if (song.artist === null) {
      if (score < 2) continue;
    } else if (!artistMatches(song.artist, track.artists)) {
      continue;
    }
    // Ties keep the earlier result, which Spotify ranked as more relevant.
    if (best === null || score > best.score) best = { track, score };
  }
  if (best === null) return { found: false };
  return { found: true, track: best.track, artistUnconfirmed: song.artist === null };
}

/** 3: same title including version labels. 2: same title. 1: nearly the same. 0: different. */
export function titleScore(wanted: string, candidate: string): number {
  if (fold(wanted) === fold(candidate) && fold(wanted) !== '') return 3;
  const a = core(wanted);
  const b = core(candidate);
  if (a === '' || b === '') return 0;
  if (a === b) return 2;
  return similarity(a, b) >= NEAR ? 1 : 0;
}

export function artistMatches(wanted: string, candidates: string[]): boolean {
  const names = candidates.map(fold).filter((name) => name !== '');
  // A reel often credits several artists in one string ("A, B & C" or "A x B").
  const pieces = [wanted, ...wanted.split(/,|&|\+|\/|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\band\b/i)]
    .map(fold)
    .filter((piece) => piece.length >= 3);
  return pieces.some((piece) =>
    names.some(
      (name) =>
        name === piece ||
        (name.length >= 3 && (` ${name} `.includes(` ${piece} `) || ` ${piece} `.includes(` ${name} `))) ||
        similarity(name, piece) >= NEAR,
    ),
  );
}

/** Lower case, no accents, no punctuation, single spaces. Letters of any script are kept. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The title without the decorations Spotify adds: "(feat. X)", "[Live]", " - Remastered 2011". */
function core(title: string): string {
  const stripped = title
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s[-–—]\s.*$/, ' ')
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ');
  // A title that is nothing but a bracket ("(Intro)") keeps its text.
  return fold(stripped) || fold(title);
}

/** 1 minus the edit distance over the longer length. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length]! / longest;
}
