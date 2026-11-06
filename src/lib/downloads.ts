// Finding a recording's copy in Downloads/Dohra/, through the browser's download
// history: an extension cannot read the Downloads folder itself. Before the video is
// removed from the browser, the copy must still be on disk, complete, and exactly
// the recording's size.

import { EXPORT_DIR, mediaFileName, type SessionMeta } from "./session";

/** Whether a downloaded file's full path is this session's media file. */
export function isSessionCopy(filename: string, meta: Pick<SessionMeta, "id" | "file">): boolean {
  const path = filename.replace(/\\/g, "/");
  return path.endsWith(`/${EXPORT_DIR}/${meta.id}/${mediaFileName(meta)}`);
}

/** The verified Downloads copy of a recording's media file, or null. */
export async function downloadsCopy(meta: SessionMeta): Promise<chrome.downloads.DownloadItem | null> {
  const items = await chrome.downloads.search({ query: [meta.id], state: "complete", exists: true });
  return items.find((d) => isSessionCopy(d.filename, meta) && d.fileSize === meta.bytes) ?? null;
}
