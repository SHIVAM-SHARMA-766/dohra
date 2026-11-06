// Copies of a session's small files in Downloads/Dohra/<id>/, beside the recording.
// A service worker cannot create blob URLs; a data URL works for files this size.

import { EXPORT_DIR } from "../lib/session";

export async function downloadJson(id: string, name: string, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  try {
    await chrome.downloads.download({
      url: `data:application/json;base64,${btoa(binary)}`,
      filename: `${EXPORT_DIR}/${id}/${name}`,
      conflictAction: "overwrite",
      saveAs: false,
    });
  } catch {
    // The copy in the library is what matters; Downloads is a convenience.
  }
}
