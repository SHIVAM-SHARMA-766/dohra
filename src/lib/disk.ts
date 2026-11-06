// How much recording time the disk has room for. With unlimitedStorage, the browser's
// storage quota for Dohra follows the disk's free space, so quota minus usage is
// what is left. A recording usually takes twice its size: the browser's copy and the
// Downloads copy, on the same disk.

/** Below this much recording time, the popup warns before starting. */
export const LOW_SPACE_MS = 2 * 60 * 60 * 1000;

export interface Space {
  freeBytes: number;
  /** Recording time that fits, for this screen and these settings. */
  timeLeftMs: number;
}

/**
 * Recording time that fits in `freeBytes` at `bytesPerHour`, when each recording is
 * stored `copies` times (1 or 2).
 */
export function recordingTimeLeft(freeBytes: number, bytesPerHour: number, copies: number): number {
  if (bytesPerHour <= 0 || copies <= 0) return Infinity;
  return Math.max(0, (freeBytes / (bytesPerHour * copies)) * 3_600_000);
}

/** How many copies of a recording the settings keep on this disk. */
export function copiesKept(s: { autoExport: boolean; keepInBrowser: boolean }): number {
  return s.autoExport && s.keepInBrowser ? 2 : 1;
}

/** Free space as the browser reports it for Dohra. */
export async function freeSpace(): Promise<number> {
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  return Math.max(0, quota - usage);
}

/** "1 h 10 min", "25 min": rough, for warnings. */
export function roughDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}
