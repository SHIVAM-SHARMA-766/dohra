# Architecture

Dohra is a Manifest V3 extension for Chromium browsers. It has no server and no build
outside the extension itself. This document explains how a recording moves through
it, how it is stored, and why each choice was made, so a reader with no prior context
can change it safely.

## The pieces

```
 popup ──start/stop/pause──▶ background (service worker)
   ▲                          │  tabCapture.getMediaStreamId
   │ chrome.storage.session   │  creates / closes
   │ (state, last error)      ▼
   └──────────────────── offscreen document ──chunks──▶ storage worker ──▶ OPFS
                          (the recorder)                (all file I/O)
                               │
                               └─ blob URLs ─▶ background ─▶ chrome.downloads ─▶ Downloads/Dohra/

 library page ── reads OPFS directly; uses the storage worker to finalize and update
```

| Directory | Role |
|---|---|
| `src/background/` | Service worker. Turns popup clicks and the `Alt+Shift+R` command into a recording. Owns everything that needs extension APIs: the tab-capture stream ID, the offscreen document's lifecycle, the badge, and downloads. Keeps the one active recording in `chrome.storage.session`. |
| `src/offscreen/` | The recorder. Captures the tab (and mic), mixes audio, plays the tab back to the speakers, runs `MediaRecorder`, and streams chunks to the storage worker. |
| `src/worker/` | Storage worker. The only code that writes recording files. |
| `src/popup/` | Toolbar popup: options, start/pause/stop, live timer. Holds no state of its own. |
| `src/library/` | Lists, plays, exports and deletes sessions, and recovers interrupted ones. |
| `src/permissions/` | One-time microphone grant (see "Microphone" below). |
| `src/lib/` | Shared code: settings, the session format, messages, storage helpers, and the WebM patcher. |
| `scripts/` | Build (esbuild), packaging, icon rendering, and the end-to-end test. |
| `test/` | Unit tests for the pure logic: the WebM patch and session naming. |

All contexts talk through `chrome.runtime.sendMessage`. That broadcasts to every
extension page, so each message carries a `target` (`"background"` or `"offscreen"`)
and receivers ignore the rest. The message types are in
[src/lib/messages.ts](src/lib/messages.ts).

## A recording, start to finish

1. **Start.** The popup sends `start` with the tab ID. The background checks that the
   page can be captured, then calls `tabCapture.getMediaStreamId`. This works only
   while the user's click (popup or shortcut) still counts, through the `activeTab`
   grant. It then creates the offscreen document and passes it the stream ID and
   options.
2. **Capture.** The offscreen document turns the stream ID into a `MediaStream` with
   `getUserMedia` and Chrome's legacy `chromeMediaSource: "tab"` constraints. Tab
   capture mutes the tab for the user, so the audio is routed through an `AudioContext`
   both to the speakers and to a mix destination. If the mic is on, it joins the mix
   only, so it is recorded but not played back.
3. **Record.** `MediaRecorder` emits a chunk every 3 seconds
   (`TIMESLICE_MS` in [settings.ts](src/lib/settings.ts)). Each chunk is posted to the
   storage worker, appended to `raw.webm`, and **flushed**. `session.json` is rewritten
   with the running duration. Writes are chained in a promise queue so they land in
   order.
4. **Progress.** After each chunk the recorder reports `{durationMs, bytes, paused, at}`.
   The background stores it in `chrome.storage.session`, and the popup redraws from
   there. The popup's timer adds `Date.now() - at`, so it ticks smoothly between the
   3-second updates.
5. **Stop.** A stop can come from the popup, the shortcut, the tab closing (the
   captured tracks end), or a write error. The recorder stops `MediaRecorder`, waits
   for the last chunk to be written, releases the streams, and asks the worker to
   **finalize**.
6. **Export.** The recorder creates blob URLs for `recording.webm` and a copy of
   `session.json`. The background downloads them to `Downloads/Dohra/<id>/`, waits for
   both downloads to complete, tells the recorder to record `exportedAt`, then closes
   the offscreen document.

Pausing calls `MediaRecorder.pause()`. Recorded duration is tracked with
`performance.now()` and excludes pauses, so a paused minute does not inflate the
length.

## Storage

Recordings live in the **origin private file system** (OPFS), scoped to the extension:

```
sessions/<id>/
  raw.webm         while recording; deleted once finalized
  recording.webm   the finished file
  session.json     metadata, rewritten on every chunk
```

`<id>` is `YYYY-MM-DD_HHMMSS_<title-slug>`, in local time, so it sorts
chronologically. A title with no Latin characters, such as a Hindi one, slugs to
`session`.

The same folder shape is used in `Downloads/Dohra/`. **This folder is the format
contract for later stages.** A transcript, notes, or slide captures become new files
beside `recording.webm`. A future desktop recorder writes the same `session.json`,
with `recorder` naming itself. `schema` versions the format.

### Why OPFS with a worker

- **Crash safety needs synchronous access handles.** Those exist only in workers. They
  write in place, and data survives a crash once flushed. The async
  `createWritable()` stream API writes to a temporary file and commits only on
  `close()`, so a crash mid-class would lose the whole recording.
- **Memory stays flat.** Chunks go straight to disk. A one-hour 720p class is about
  560 MB, and none of it is held in memory.
- **No permission prompts.** The File System Access API could write straight to a
  user-chosen folder, but an offscreen document cannot show the permission prompt it
  needs, and the grant can lapse when the browser restarts. Downloads works without
  either problem.

The cost is that each finished recording exists **twice**: once in the browser profile
and once in Downloads. The library shows how much the browser is using, and deleting a
session there leaves the Downloads copy. Turning off "save a copy to Downloads" avoids
the duplicate, but the recording then disappears if the extension is removed.

### Finalizing: header repair and hash

Chrome's `MediaRecorder` writes two things into the WebM header that need fixing.
[webm.ts](src/lib/webm.ts) repairs both with a minimal EBML edit:

- **Missing Duration.** It streams, so it never goes back to write how long the
  recording was. Without a Duration, players show no length and Chrome cannot seek.
- **A false AlphaMode.** It marks VP8 tracks as carrying transparency
  (`AlphaMode = 1`) when they have none. Chrome ignores the flag. GStreamer — and so
  GNOME Videos (Totem), the default player on many Linux desktops — sends the stream to
  an alpha decoder, which fails with "Cannot handle streams without an initial alpha
  buffer". Totem reports that as a missing codec. A tab never has transparency, so the
  flag is zeroed.

The repair:

1. Read the first 64 KiB. MediaRecorder's header is a few hundred bytes.
2. Find `Segment → Info`, and add a float64 `Duration`, or overwrite one that already
   exists.
3. Grow the Info size field, and the Segment size if it is known (MediaRecorder writes
   "unknown").
4. Find `Segment → Tracks → TrackEntry → Video → AlphaMode`, and zero it in place.
5. Write the new head, then copy the rest of `raw.webm` across unchanged, in 4 MiB
   chunks.

The copy pass also computes the **SHA-256** of `recording.webm`, using `@noble/hashes`
because WebCrypto cannot hash incrementally. The hash goes into `session.json` and
lets an exported copy be checked later.

Finalizing is idempotent. `raw.webm` is deleted only after `recording.webm` is
complete, so an interrupted finalize can simply run again. If the header cannot be
repaired, the file is still copied, and the session carries a warning, because a
recording that cannot be seeked beats losing it.

### Recovery

When the library opens, any session still marked `recording` or `finalizing`, and not
currently being recorded, is finalized with `endReason: "recovered"`, using the last
duration saved in `session.json`. At most one chunk (3 seconds) is lost. If
`session.json` itself is unreadable, the library supplies placeholder metadata so the
audio and video are still saved.

The background also clears stale "active" state on startup if no offscreen document
exists. `chrome.storage.session` is wiped when the browser restarts anyway.

## Browser constraints this design works around

| Constraint | Consequence |
|---|---|
| MV3 service workers have no DOM | Recording happens in an offscreen document (reasons `USER_MEDIA`, `WORKERS`, `BLOBS`). |
| Offscreen documents get only part of `chrome.runtime` | The background passes in the extension version. Downloads go through the background. |
| Offscreen documents cannot show permission prompts | The microphone is granted once on `permissions.html`. The grant covers the whole extension origin. |
| `tabCapture` needs a user gesture on that tab | The flow always starts from the popup or the keyboard command. Recording cannot auto-start. |
| Without `activeTab`, `tabs.get()` hides the tab's URL | `activeTab` is requested. It grants access only to the tab the user invoked Dohra on. |
| Tab capture mutes the tab | Captured audio is played back through an `AudioContext`. |
| `AUDIO_PLAYBACK` offscreen documents close after 30 s of silence | That reason is deliberately not used; a quiet class must not end the recording. |

## Settings

Stored in `chrome.storage.local`:

| Setting | Values |
|---|---|
| Mode | `video` or `audio` |
| Quality | 480p, 720p (default) or 1080p |
| Microphone | on or off |
| Auto-export | on or off |

Video is VP8 and audio is Opus at 96 kbps. VP8 is chosen over VP9 because VP9 encoding
is much heavier on the CPU, which matters on an ordinary laptop that is also running
the class. The bitrates (600 kbps, 1.2 Mbps and 2.5 Mbps) suit lecture content: mostly
static slides, where sharp text matters more than smooth motion.

## Testing

- **Unit tests** (`npm test`) cover the WebM repair against synthetic EBML: the
  MediaRecorder layout, a known Segment size, an existing Duration, a size field that
  has to widen, Chrome's AlphaMode, a cut-off Tracks element, and malformed input. They also cover session naming and formatting.
- **End-to-end** (`npm run e2e`, [scripts/e2e.mjs](scripts/e2e.mjs)) loads the built
  extension into real Chromium and drives it through the popup against a test page
  with moving video and a steady tone. It covers three scenarios:
  - a paused video recording with the microphone;
  - an audio-only recording ended by closing the tab;
  - a browser killed with `SIGKILL` mid-recording and then recovered.

  Each recording is checked for duration, seeking, audible audio, video size, raw-file
  cleanup, and the SHA-256 of the Downloads copy. The Downloads copy is also played
  through GStreamer ([scripts/gst-play.py](scripts/gst-play.py)), because a file Chrome
  plays is not necessarily one a desktop player accepts. That is how the AlphaMode
  problem slipped through the first version.

  Two quirks of the test setup:
  - Headless Chromium captures tab audio as silence, so the test runs headful under
    `xvfb-run`.
  - `--use-fake-ui-for-media-stream` breaks tab capture, so the microphone is granted
    through the permissions API instead.

  CI runs both on every push.

Not covered automatically: hearing tab audio through the speakers while recording,
hour-long recordings, and laptop sleep during a recording. These need a manual check.

## Known limits

- Chromium browsers only. Firefox has no equivalent of `tabCapture` for extensions.
- Duration is measured with `performance.now()`. If the laptop sleeps mid-recording,
  the stored Duration may not match the media exactly. The file still plays.
- Without headphones, the microphone also records the class from the speakers. Echo
  cancellation reduces this but does not remove it.
