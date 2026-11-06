// Bookmarks: moments marked while recording (Alt+Shift+B, or the popup's Bookmark
// button), kept as bookmarks.json in the session folder and shown on the
// recording's page, to jump straight to what mattered.

import { FILES } from "./session";
import { readSessionJson, writeSessionJson } from "./transcript";

export interface Bookmark {
  /** Recorded time, excluding pauses, like the transcript's. */
  ms: number;
  /** When it was marked (ISO 8601). */
  at: string;
}

export interface Bookmarks {
  schema: 1;
  bookmarks: Bookmark[];
}

/** Marks closer together than this are one bookmark: a double press, not two moments. */
export const SAME_MOMENT_MS = 3_000;

export async function readBookmarks(id: string): Promise<Bookmark[]> {
  return (await readSessionJson<Bookmarks>(id, FILES.bookmarks))?.bookmarks ?? [];
}

/** Adds a bookmark at `ms` unless one is already that close; returns the list. */
export async function addBookmark(id: string, ms: number): Promise<Bookmark[]> {
  const list = await readBookmarks(id);
  if (list.some((b) => Math.abs(b.ms - ms) < SAME_MOMENT_MS)) return list;
  const next = [...list, { ms: Math.round(ms), at: new Date().toISOString() }].sort((a, b) => a.ms - b.ms);
  await writeSessionJson(id, FILES.bookmarks, { schema: 1, bookmarks: next } satisfies Bookmarks);
  return next;
}
