// Searching the library: a recording matches by its title, or by lines of its
// transcript ("which class covered BFS?"). Lines match in either script and by the
// speaker's name, like the search on a recording's page.

import { speakerLabel, type TranscriptLine } from "./transcript";
import { searchKey } from "./translit";

export interface LineMatch {
  line: TranscriptLine;
  /** Position of the query in the line's text, or -1 when only the speaker matched. */
  at: number;
}

export interface SessionMatch {
  title: boolean;
  lines: LineMatch[];
  /** All matching lines, of which `lines` holds the first few. */
  total: number;
}

/**
 * How a recording matches `query` (already trimmed and lowercased), or null. The
 * query's words must all appear, in any order, in the title or in one line.
 */
export function matchSession(title: string, lines: TranscriptLine[], query: string, max = 3): SessionMatch | null {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const has = (key: string) => words.every((w) => key.includes(w));
  const found: LineMatch[] = [];
  let total = 0;
  for (const line of lines) {
    const text = searchKey(line.text);
    if (!has(`${text} ${speakerLabel(line).toLowerCase()}`)) continue;
    total++;
    if (found.length < max) found.push({ line, at: text.indexOf(words[0]!) });
  }
  const inTitle = has(searchKey(title));
  return inTitle || total > 0 ? { title: inTitle, lines: found, total } : null;
}
