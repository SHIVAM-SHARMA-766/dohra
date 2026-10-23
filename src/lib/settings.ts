// Recording options and how they map to capture constraints and encoder settings.

export type Mode = "audio" | "video";
export type Quality = "480p" | "720p" | "1080p";
/** Spoken language hint for transcription. "auto" detects it from the first speech. */
export type Language = "auto" | "hi" | "en";

export interface Settings {
  mode: Mode;
  quality: Quality;
  mic: boolean;
  /** Copy each finished recording to Downloads/Dohra/ automatically. */
  autoExport: boolean;
  /** Transcribe while recording, if the companion is installed. */
  transcribe: boolean;
  language: Language;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: "video",
  quality: "720p",
  mic: false,
  autoExport: true,
  transcribe: true,
  language: "auto",
};

interface QualityProfile {
  width: number;
  height: number;
  frameRate: number;
  videoBitsPerSecond: number;
}

// Bitrates are tuned for lectures: mostly static slides and a talking head, where
// motion is low and text sharpness matters more than smooth movement.
export const QUALITY: Record<Quality, QualityProfile> = {
  "480p": { width: 854, height: 480, frameRate: 30, videoBitsPerSecond: 600_000 },
  "720p": { width: 1280, height: 720, frameRate: 30, videoBitsPerSecond: 1_200_000 },
  "1080p": { width: 1920, height: 1080, frameRate: 30, videoBitsPerSecond: 2_500_000 },
};

export const AUDIO_BITS_PER_SECOND = 96_000;

/** How often MediaRecorder hands over data. Also the most a crash can lose. */
export const TIMESLICE_MS = 3_000;

/** Approximate size of one hour of recording, for display before starting. */
export function estimateBytesPerHour(mode: Mode, quality: Quality): number {
  const bits = AUDIO_BITS_PER_SECOND + (mode === "video" ? QUALITY[quality].videoBitsPerSecond : 0);
  return (bits / 8) * 3600;
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}
