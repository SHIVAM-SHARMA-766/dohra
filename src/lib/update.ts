// Updates from Dohra's GitHub releases. Chrome never updates an extension loaded
// with "Load unpacked", so the companion rewrites the extension's folder and
// replaces itself, and the extension then reloads (background/updater.ts).
// Without the companion, Dohra can only say that an update exists.

export const REPO = "SHIVAM-SHARMA-766/dohra";
export const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** A folder a browser profile loads Dohra from, as the companion found it. */
export interface Place {
  dir: string;
  /** Why it will not be updated; absent if it will. */
  skip?: string;
}

/** What "Check for updates" found, kept under UPDATE_KEY in chrome.storage.local. */
export interface UpdateStatus {
  checkedAt: number;
  current: string;
  latest: string;
  available: boolean;
  url: string;
  notes: string;
  /** The companion's version, or null without a companion that can update. */
  companion: string | null;
  /** Where the update would go; empty without the companion. */
  places: Place[];
  /** Whether "Update now" can do it; otherwise `why` says what to do instead. */
  canApply: boolean;
  why?: string;
}

/** What "Update now" did. */
export interface UpdateResult {
  version: string;
  updated: string[] | null;
  companion: boolean;
}

export const UPDATE_KEY = "update";
/** Set just before the extension reloads itself, so the new version can say it was updated. */
export const UPDATED_KEY = "updatedTo";

/**
 * Whether version a is newer than b ("0.10.0" > "0.9.2"); "v" prefixes are
 * ignored. Either one not numeric, such as a companion built from source ("dev"),
 * means no: a build from source is never replaced by a release.
 */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const pa = parse(a);
  const pb = parse(b);
  const valid = (p: number[]) => p.length === 3 && !p.some(Number.isNaN);
  if (!valid(pa) || !valid(pb)) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! > pb[i]!;
  }
  return false;
}
