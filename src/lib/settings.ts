// Recording settings, and how the capture size maps to encoder settings.
//
// Every recording is audio + video at the screen's full resolution, with the
// microphone. Those are not choices. Transcripts are on by default and can be turned
// off, leaving Dohra a plain recorder. What remains configurable lives on Dohra's
// Settings page.

export type Mode = "audio" | "video"; // "audio" only in recordings made before 0.3

export interface Settings {
  /**
   * Show a microphone switch in the quick-start popup. Off (the default), the
   * microphone is always recorded and the popup does not mention it.
   */
  micSwitchInPopup: boolean;
  /** The popup's microphone switch; only used while micSwitchInPopup is on. */
  mic: boolean;
  /** Copy each finished recording to Downloads/Dohra/ automatically. */
  autoExport: boolean;
  /** Transcribe recordings live. Off, Dohra only records and needs no companion. */
  transcribe: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  micSwitchInPopup: false,
  mic: true,
  autoExport: true,
  transcribe: true,
};

/** Whether the next recording includes the microphone. */
export function micEnabled(s: Settings): boolean {
  return s.micSwitchInPopup ? s.mic : true;
}

export const AUDIO_BITS_PER_SECOND = 96_000;
export const FRAME_RATE = 30;

// Bits per pixel per frame. 0.043 gives 1.2 Mbps at 720p — tuned on lectures, which are
// mostly static slides where sharp text matters more than smooth motion — and scales
// the same density to larger screens.
const BITS_PER_PIXEL_FRAME = 0.043;
const MIN_VIDEO_BPS = 1_200_000;
const MAX_VIDEO_BPS = 8_000_000;

export function videoBitsPerSecond(width: number, height: number): number {
  const bps = width * height * FRAME_RATE * BITS_PER_PIXEL_FRAME;
  return Math.round(Math.min(MAX_VIDEO_BPS, Math.max(MIN_VIDEO_BPS, bps)));
}

/** The screen's size in device pixels: the most detail a tab capture can hold. */
export function screenResolution(): { width: number; height: number } {
  // Read loosely: this module is also compiled for workers, which have no screen.
  const g = globalThis as unknown as { screen?: { width: number; height: number }; devicePixelRatio?: number };
  const dpr = g.devicePixelRatio || 1;
  const { width, height } = g.screen ?? { width: 1920, height: 1080 };
  return { width: Math.round(width * dpr), height: Math.round(height * dpr) };
}

/** Approximate size of one hour of recording at a given resolution. */
export function estimateBytesPerHour(width: number, height: number): number {
  return ((AUDIO_BITS_PER_SECOND + videoBitsPerSecond(width, height)) / 8) * 3600;
}

/** How often MediaRecorder hands over data. Also the most a crash can lose. */
export const TIMESLICE_MS = 3_000;

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  const stored = (settings ?? {}) as Partial<Settings>;
  // Keep only known keys, so settings from older versions (mode, quality, ...) drop out.
  return {
    micSwitchInPopup: stored.micSwitchInPopup ?? DEFAULT_SETTINGS.micSwitchInPopup,
    mic: stored.mic ?? DEFAULT_SETTINGS.mic,
    autoExport: stored.autoExport ?? DEFAULT_SETTINGS.autoExport,
    transcribe: stored.transcribe ?? DEFAULT_SETTINGS.transcribe,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
