# Architecture

Dohra is a Manifest V3 extension for Chromium browsers, plus an optional local
companion program (Go, in `companion/`) that transcribes with whisper.cpp. There is no
server. This document explains how a recording and its transcript move through the
system, how they are stored, and why each choice was made, so a reader with no prior
context can change it safely.

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

 transcription (optional):
 offscreen ──16 kHz PCM per stream──▶ background ══native messaging══▶ dohra-companion ──▶ whisper-cli
                                         ▲   │                              (Go)        chunk by chunk
                                         │   └─ transcript.json ─▶ OPFS + Downloads/Dohra/
                                         └──────── lines / progress / done ──────┘
 session page ── player + transcript from OPFS; reloads as the background saves
```

| Directory | Role |
|---|---|
| `src/background/` | Service worker. Turns popup clicks and the `Alt+Shift+R` command into a recording. Owns everything that needs extension APIs: the tab-capture stream ID, the offscreen document's lifecycle, the badge, and downloads. Keeps the one active recording in `chrome.storage.session`. |
| `src/offscreen/` | The recorder. Captures the tab (and mic), mixes audio, plays the tab back to the speakers, runs `MediaRecorder`, and streams chunks to the storage worker. |
| `src/worker/` | Storage worker. The only code that writes recording files. |
| `src/popup/` | Quick start: title, start/pause/stop, live timer, and a summary of what will be recorded. Holds no state of its own. |
| `src/settings/` | Dohra's settings page: transcripts on or off, the speech models, the microphone switch for the popup, the Downloads copy, and updates. |
| `src/library/` | Lists, opens, exports and deletes sessions, shows transcript state, and recovers interrupted recordings. |
| `src/session/` | One recording: player and transcript, seek-on-click, follow, search, script toggle, `.txt` download, and transcribing a recording after the fact. |
| `src/setup/` | First-run setup, opened on install: microphone, transcripts or recording only, then (for transcripts) companion install commands with a live check and the speech-model choice. |
| `src/content/` | Scripts injected into a meeting tab while it is recorded: the meeting's mute state and who is speaking. |
| `src/permissions/` | One-time microphone grant (see "Microphone" below). |
| `src/lib/` | Shared code: settings, the session format, messages, storage helpers, the WebM patcher, the transcript format, Devanagari-to-Roman transliteration, the speech-model list, and the line icons. `src/ui.css` is the design system every page builds on: colour tokens for light and dark, buttons, switches, cards, chips. |
| `companion/` | The transcription companion: native messaging host, chunking, the Whisper queue, crash-safe session store, model downloads, and the installer. See "Transcription" below. |
| `scripts/` | Build (esbuild), packaging, icon rendering, the GStreamer playback check, and the end-to-end test. |
| `test/` | Unit tests for the extension's pure logic. The companion's tests live beside its code (`go test ./...`). |

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
  transcript.json  once transcribed
  speakers.json    who was speaking when, for recordings of Meet or Teams
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
- **Memory stays flat.** Chunks go straight to disk. A one-hour class at 1920×1080 is
  about 1.2 GB, and none of it is held in memory.
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

## Transcription

### Why a companion program

Whisper needs real CPU and a ~0.5 GB model. Running it inside the browser (WebAssembly)
would be several times slower than native whisper.cpp, would compete with the class in
the same process, and would make the model a per-profile download. A native program
gets the full CPU at a controllable priority. Chrome's **native messaging** connects
it to the extension without opening a port: the browser starts the program, talks to
it over stdin/stdout, and only the extension ID named in its host manifest may do so.

That last point is why the manifest carries a `key`: it fixes the extension ID
(`dkihabdjpgkkichdojcgbplmjkcboipg`) on every machine, where an unpacked extension's ID
would otherwise depend on its folder's path.

### Measurements that shaped it

On the target laptop (Ryzen 5 7430U, 6 cores / 12 threads, no GPU), using 5 minutes of
a real meeting:

| Model | 3 threads | 6 threads | RAM |
|---|---|---|---|
| Small: small (q5_1) | 3.2× real time | 4.9× | 0.6 GB |
| Medium: medium (q5_0) | 1.03× | 1.6× | 1.2 GB |
| High: Hindi2Hinglish Apex (q5_0) | 0.76× | 1.09× | 0.8 GB |
| (replaced) large-v3-turbo (q5_0) | 0.76× | 1.21× | 0.9 GB |
| (not offered) large-v3 (q5_0) | 0.46× | — | 2.1 GB |

The last three were measured on a 2-minute part of the same meeting, where medium ran
at 0.94× with 3 threads. With VAD skipping silence, High transcribed the whole 51-minute
meeting in 36 minutes at 6 threads.

- **Medium is the default recommendation** because small got technical terms and names visibly wrong
  ("set two and three, info" for "SEV 2 and 3, infra"). Greedy decoding instead of beam
  search bought 15% speed and brought the same errors back, so beam search stays.
- **High is Oriserve's Hindi2Hinglish Apex.** It is large-v3-turbo fine-tuned on about
  700 hours of noisy, Indian-accented Hindi, and it writes Roman Hinglish by itself.
  On six real recordings with known text (from its model card), plain models failed:
  turbo wrote "Uh-huh. They can't." for "Haan haan, dekhe hain", and medium wrote
  "Lenga saathu chaiji". Apex got four exactly right and two nearly. It was also
  right on the Hinglish and Hindi clips and on English, at turbo's speed. It runs with
  `-l en` and no prompt; `-l hi` turned English speech into a loop of Devanagari
  letters. It emits one segment per 30-second window, so `-ml 100 -sow` splits lines
  at words using token timestamps. No ready-made trustworthy whisper.cpp build
  existed, so [companion/tools/convert-hf-whisper.py](companion/tools/convert-hf-whisper.py)
  converts the official safetensors with numpy alone. The q5_0 result is a release
  asset in the public `SHIVAM-SHARMA-766/dohra-models` repository, pinned by SHA-256.
- **Before Apex, High was large-v3-turbo, not large-v3.** Full large-v3 is too slow to finish an
  hour-long class in reasonable time (0.46×), needs 2 GB of RAM, and on the sample fell
  into a loop repeating one line. Turbo keeps large-v3's encoder with a 4-layer
  decoder: twice as fast, less memory. On this English sample it was not better than
  medium ("save two and three info infra", without punctuation). Its expected gain is
  in Hindi, which has not been measured yet. With it, a one-hour class finishes about
  15 minutes after it ends.
- **Chunks are about 2 minutes.** Whisper encodes 30-second windows and re-encodes from
  the last complete line at the end of every run, so each run pays about one extra
  window. Measured: a 28-second chunk ran at 0.7× real time, 2 minutes at 1.0×.
- **Hinglish, written in Roman script.** Whisper has no Hinglish. Three ways were
  tried on a Hindi-English teaching clip, a pure-Hindi clip and an English one:
  - `-l auto` detects per chunk (an extra encoder pass, ~10%). A mixed chunk came out
    in Devanagari with English words in Latin. A short or English-heavy chunk was
    taken for English, and the Hindi in it was dropped. That is what users saw.
  - `-l hi` gives the same Devanagari, always.
  - `-l en` with a Roman-Hinglish `--prompt` ("Haan toh students, aaj hum…") writes
    what people type: "Acha toh students, aaj hum binary search tree ke baare mein
    padhenge". Pure Hindi was romanised, not translated ("Meri maa ne kaha ki khaana
    ban gaya hai"), and English stayed English. This held with all three models.

  Dohra uses the third (`language: "hinglish"`), which also skips detection. On the
  mixed clip in Devanagari, High was clearly best ("छोटी", "ठीक है?" where Small and
  Medium wrote "चोटी", "तीक है"). In Roman, Medium and High were close; High
  sometimes adds accents ("á jau").
- **Runaway repeats are cut.** Whisper sometimes loops on one word to the end of a
  window ("hello hello hello…" for ten seconds). More than three of the same word in a
  row are collapsed to three and "…".
- **Model load is 0.3 s**, so starting `whisper-cli` per chunk is cheaper than keeping a
  server process alive.

### The pipeline

1. **Tap** ([src/offscreen/tap.ts](src/offscreen/tap.ts)). When the companion has
   accepted the session, the recorder opens a second, 16 kHz `AudioContext`. One
   AudioWorklet per source turns the tab ("them") and the microphone ("me") into
   1-second blocks of 16-bit PCM. Keeping them separate is what labels lines "Me" or
   "Them" without guessing. Blocks are dropped while paused, keeping the transcript's
   clock aligned with the recording, which also excludes pauses. On stop the worklets
   flush their partial block before the background hears "finalizing", so no audio is
   lost.
2. **Relay** ([src/background/transcriber.ts](src/background/transcriber.ts)). The
   service worker holds one native port for all sessions and forwards blocks as base64.
   An open native port keeps the service worker alive, which matters after class while
   the companion catches up. The port is closed 10 s after the last session finishes.
3. **Chunk and queue** ([companion/internal/engine](companion/internal/engine)). The
   companion appends each block to `<id>/them.pcm` or `me.pcm` (fsynced), and cuts the
   stream into ~2-minute chunks at the quietest half second in the last 30 seconds, so
   words are not split. One worker runs the queue in order: 3 threads while any session
   is still recording, then 6 so the queue catches up. Whisper runs at low priority
   (`nice 10`, or below-normal on Windows) so the class and the recorder always win.
   Chunks that are silent (below about -50 dBFS, like an unused microphone) are skipped
   without running Whisper, and Silero VAD inside Whisper skips silence within chunks.
   Both stop Whisper inventing text such as "Thank you." over silence.
4. **Save.** For each finished chunk the companion sends `lines` and `progress`. The
   background (debounced) fetches the whole transcript in pages — Chrome limits
   host-to-extension messages to 1 MiB — and rewrites `transcript.json` in the session
   folder. Pages reload when `chrome.storage.session.transcripts` changes. On `done`, the
   final file is written and copied to `Downloads/Dohra/<id>/transcript.json`.

**Importing a file** ([storage.ts](src/lib/storage.ts) `importMedia`) copies it into a
new session folder as `recording.<ext>`, which `session.json`'s `file` names. Its
length and picture size come from a hidden media element. Chrome does not load media
in a background tab, so after 15 s the import goes on without them, and the session
page fills them in from its player or from decoding. The session is then transcribed
like any finished recording.

**Transcribing a recording afterwards** reuses the same path with one stream, "mixed".
The session page decodes the media file to 16 kHz with `OfflineAudioContext`, mixes
it to mono one 10-second block at a time, and sends the blocks. Simple, but it holds
the decoded audio in memory: about 120 MB per hour per channel, plus the file itself.

### Protocol

Requests carry an `id` and get exactly one `{"type":"reply","id",…}`. `audio` is
fire-and-forget; an error with it comes back as an `error` event.

| Request | Effect |
|---|---|
| `hello` | Version, readiness, problems ("no speech model installed"), CPU count, and every model's state |
| `start {sessionId, language}` | Begin a session, or rejoin one still receiving. Starting a finished one replaces its transcript. |
| `audio {sessionId, stream, pcm}` | Append base64 16 kHz int16 samples to a stream |
| `stop {sessionId}` | No more audio; queue the remainder |
| `status` | Every unfinished session's progress |
| `transcript {sessionId, from}` | Up to 500 committed lines from index `from` |
| `models` | The model list, as in `hello` |
| `model-install {model}` | Start downloading a model in the background; replies at once |
| `model-cancel {model}` | Stop a download, keeping what arrived |
| `model-use {model}` | Make an installed model the active one |
| `update-check` | The latest release (version, page, notes), the companion's version, and the folders Dohra is loaded from, each with a reason if it cannot be updated |
| `update-apply` | Update those folders and the companion itself; replies when done (see "Updates") |
| `model-remove {model}` | Delete a model that is not active |

The model requests all reply with a fresh `hello`.

Events: `progress {receivedMs, doneMs, queued}`, `lines`,
`done {state: complete|failed, error}`, and for downloads
`model-progress {model, done, size}` (at most four a second) and
`model-done {model, error}`.

### Speech models

Speech models are chosen **only in Dohra**: on the setup page during first install,
and afterwards in Settings. Both use the same list
([src/lib/model-picker.ts](src/lib/model-picker.ts)), which offers download,
progress, cancel, **Use this model** and **Remove**. `dohra-companion install` sets up
everything except a model. Its `--model` flag is for scripted installs and tests.

- The companion runs without a model; `hello` then reports not ready. When a download
  finishes and no usable model is active, the new one becomes active and the engine
  starts in the running process, so setup needs no restart.
- Downloads run in the companion ([companion/internal/models](companion/internal/models)).
  The companion exits when Chrome disconnects, so the background keeps the native port
  open while any download runs, just as it does for unfinished transcripts.
- A download that stops is kept as `<model>.part`. The next attempt hashes the part,
  asks the server only for the rest (`Range`), and verifies the SHA-256 of the whole.
  A part that fails verification is deleted.
- Switching applies to every chunk not yet transcribed, including those of a class in
  progress. The chunk running at that moment finishes with the old model. The active
  model cannot be removed.
- If the active model's file disappears, the companion falls back to another
  installed model.
- The page recommends **Medium** on 8 or more logical CPUs and **Small** below that.

### Surviving crashes and closed browsers

The companion is killed whenever Chrome disconnects, including when the browser
closes mid-catch-up. Its session store
([companion/internal/store](companion/internal/store)) is built for that:

- Each stream tracks `received`, `chunked` and `done`, in samples, in `meta.json`
  (replaced atomically).
- Lines are appended to `lines.jsonl` with their chunk and a run ID *before* `done`
  advances. Reading ignores lines from chunks not yet done, and keeps only the latest
  run of a chunk that was interrupted after writing.
- On start, `Resume()` re-queues everything between `done` and `received`.
- Once a session is complete, its PCM is deleted; the recording itself is the copy that
  matters.

On the extension side, the background scans for `transcript.json` files still marked
`live` or `transcribing` whenever it starts. If the companion still has the session
queued, its events finish the job. If it finished while the browser was closed, the
result is fetched and saved.

A Whisper failure fails that session, not the companion. Its error is shown on the
session page, which offers **Try again**.

### Installer

`dohra-companion install` copies itself into the data directory
(`~/.local/share/dohra`, `~/Library/Application Support/Dohra`, or
`%LOCALAPPDATA%\Dohra`; `DOHRA_HOME` overrides). It then downloads:

- a pinned whisper.cpp build (`b5454`);
- the Silero VAD model.

It downloads no speech model; see [Speech models](#speech-models).

Each download is checked against a SHA-256 in
[companion/internal/config](companion/internal/config). Archive entries that would
escape the target directory are rejected. Finally it writes the native messaging host
manifest:

- **Linux and macOS:** into each installed browser's `NativeMessagingHosts` directory.
- **Windows:** into the data directory, with registry keys pointing to it.

Re-running `install` is cheap: anything already present and verified is kept. macOS has
no prebuilt whisper.cpp command-line binary, so there it comes from Homebrew.

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
| Offscreen documents cannot use `connectNative` | The recorder sends PCM to the background, which owns the native port. |
| A service worker cannot create blob URLs | `transcript.json` is exported to Downloads as a `data:` URL. |
| Unpacked extension IDs depend on the folder path | The manifest pins a `key`, so the ID the companion trusts is the same everywhere. |

## Recording format and settings

Since 0.3, the format is not a choice:

- **Audio and video.** The tab is captured with its size limited to the screen's
  resolution in device pixels. In practice that is the tab's own size, at full detail.
- **The microphone**, unless the settings allow a per-recording switch.
- **A transcript**, in Hinglish, unless `transcribe` is off.

Older recordings may be audio-only or carry a quality such as "720p". The session
format still describes both.

Video is VP8 and audio is Opus at 96 kbps. VP8 is chosen over VP9 because VP9 encoding
is much heavier on the CPU, which matters on an ordinary laptop that is also running
the class.

The video bitrate scales with the captured pixels at 0.043 bits per pixel per frame,
the density that gave 1.2 Mbps at 720p, which was tuned on lectures: mostly static
slides, where sharp text matters more than smooth motion. That is about 2.7 Mbps
(1.2 GB per hour) at 1920×1080. It is clamped between 1.2 and 8 Mbps.
`session.json` records the actual capture size, e.g. `"quality": "1920x1080"`.

Settings, stored in `chrome.storage.local` and edited on `settings.html`:

| Setting | Values |
|---|---|
| `micSwitchInPopup` | off (default): the microphone is always recorded and the popup does not mention it. On: the popup shows "Include my microphone". |
| `mic` | the popup switch's state; ignored while `micSwitchInPopup` is off |
| `autoExport` | on (default) or off: copy recordings and transcripts to Downloads |
| `transcribe` | on (default) or off. Off, Dohra is a plain recorder: the background never contacts the companion for a recording, and no transcript or "not transcribed" state is written. A transcript can still be made later from the recording's page. Switchable in the popup, Settings, and setup ("No, just record"). |

Settings from earlier versions (mode, quality, language) are ignored. `transcribe` was
removed in 0.3 and came back in 0.6 with a new meaning, so an old stored value is
honoured.

The microphone needs permission once. While it is required and not granted, the
popup's Start button is disabled and links to the permission page.

### Following the meeting's mute

Dohra captures the microphone itself, not through the meeting, so muting in the
meeting does not reach it. The offscreen recorder therefore sends the microphone
through a gain node, the *gate*, which feeds both the recording mix and the
transcript tap. Muted means gain 0, with a 15 ms ramp so the cut does not click. The
microphone track keeps running, so unmuting is instant and the timeline stays whole.

Two things close the gate (`micMuted` in [messages.ts](src/lib/messages.ts)):

- **The meeting.** On a meeting site, the background injects
  [content/meeting-mic.ts](src/content/meeting-mic.ts) into the recorded tab with
  `chrome.scripting`, using the access the user's click granted (`activeTab`). No site
  permissions are needed. The script reads your own mic button's label: "Turn on
  microphone" (Meet, which also sets `data-is-muted`), "Unmute" (Teams), "unmute my
  microphone" (Zoom). It reports changes, found by a MutationObserver plus a 1-second
  timer. Labels about other people ("Mute all", "Mute Asha's microphone") are
  ignored. The background waits up to 0.8 s for the first report, so a recording
  started while muted starts muted.
- **Dohra.** The popup's Mute button.

The script runs only on Meet, Teams, Zoom and Webex (`isMeetingHost`). Elsewhere a
"Mute" button is usually a video player's sound, not your microphone. A meeting UI in
another language, or a redesign that changes the labels, leaves the state unknown, and
then only Dohra's own Mute applies. The e2e test serves a Meet-like page at
`meet.google.com`, via `--host-resolver-rules`, to check the whole path.

### Who is speaking

Dohra records the meeting's mixed audio, which cannot tell voices apart, and the
companion does no speaker separation. The meeting page can: each participant's tile
shows a speaking indicator. While a Meet or Teams tab is recorded, the background also
injects [content/meeting-speakers.ts](src/content/meeting-speakers.ts) (same
`chrome.scripting` + `activeTab` path as the mute watcher; Zoom and Webex are not
read).

- **Finding tiles.** Meet: the outermost `[data-participant-id]` elements. Teams: the
  nearest ancestor of each `[data-tid="voice-level-stream-outline"]` that holds a name.
  These attributes have stayed stable across versions; class names have not. Elements
  in the participants list or a dialog, and tiles smaller than 40×30 px, are skipped.
- **Names.** `pickName` in [lib/meeting-speakers.ts](src/lib/meeting-speakers.ts) takes
  the first text in the tile that reads like a name (preferring `.notranslate`,
  `data-self-name` and Teams' name `data-tid`s), skipping icon ligatures such as
  `more_vert`, and trims "(Presenting)", "(Host)" and "(You)". "(You)" or "You" marks
  your own tile.
- **Speaking.** The generated class names of the indicator change between versions,
  so they are not named. Instead a MutationObserver counts `class`/`style` changes
  inside each tile: an animating indicator changes constantly, a still video tile
  does not. A tile with at least 2 changes in the last 700 ms is speaking, held for
  600 ms more to bridge short gaps (`ActivityTracker`). Sampled every 250 ms; only
  changes are reported, with the number of tiles found.
- **Timeline.** The background stamps each report with the recorded time
  (`liveDuration`, which excludes pauses, like the transcript's audio) and keeps the
  list in memory, writing `speakers.json` a second after each change and once more as
  the recording stops ([background/speakers.ts](src/background/speakers.ts)).
- **Naming lines.** Every time the background rewrites `transcript.json`, `nameLines`
  gives each `them` line the name that was speaking for most of it (±0.5 s), ignoring
  your own tile since your voice is not in the tab's audio. `me` lines are never
  named. In a transcript made later from the mixed recording, your tile counts and is
  called "Me". The name is stored as `name` on the line; pages show it instead of
  "Them" (`speakerLabel`).

`tiles` in each event says whether the page could be read at all: a run of `0` after a
meeting redesign means the selectors need updating, and lines simply fall back to
"Them". The e2e meeting page has three tiles, one with an animating indicator, and the
test checks both the timeline and the names on the transcript's lines.

## Updates

Chrome never updates an extension loaded with **Load unpacked**; it only reads the
folder again when the extension reloads. The companion runs as the user, so it can
rewrite that folder ([companion/internal/update](companion/internal/update/update.go)).

1. **Check.** Settings sends `update-check` to the background
   ([background/updater.ts](src/background/updater.ts)), which asks the companion. The
   companion reads GitHub's latest release and its `SHA256SUMS`, and finds where Dohra
   is loaded from: every profile of Chrome, Chromium, Brave and Edge
   (`paths.BrowserDataDirs`), in `Preferences` and `Secure Preferences`, entry
   `extensions.settings.<Dohra's ID>` with `location` 4 (unpacked) and an absolute
   `path`. A folder whose `manifest.json` is not Dohra's, or that sits in a checkout
   (`../package.json` and `../src/manifest.json`), is reported with a reason and left
   alone. Without a companion that can update (none, or one before 0.6), the
   background reads the release from GitHub itself, so Dohra can still say that an
   update exists and how to apply it by hand. The background repeats the check once a
   day, quietly; the popup shows a banner when one is found.
2. **Apply.** `update-apply` is refused while recording, since a reload ends the
   recording. The companion downloads `dohra-extension.zip` (checked against
   `SHA256SUMS`, resumable like model downloads), unpacks it beside the folder, checks
   that it is Dohra at the release's version, and writes each file over the old one
   (write to a temporary name, then rename). Files are never deleted: the folder is
   the user's and may hold other things. Then, if the release is newer than itself, it
   downloads its own binary for this platform, renames the running one aside (Windows
   cannot overwrite a running `.exe`), moves the new one in, and runs its `install
   --no-register`, which fetches any newer whisper.cpp it pins. The old process keeps
   running until the browser disconnects.
3. **Reload.** The background stores `updatedTo` and calls `chrome.runtime.reload()`.
   Chrome reads the new files; `onInstalled` (reason `update`) reopens Settings, which
   says Dohra was updated and checks again. Chrome re-checks Developer mode on reload
   and disables an unpacked extension without it (`DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION`),
   so the README asks to leave it on.

A version that is not numeric (`dev`, a companion built from source) is never
replaced. `DOHRA_UPDATE_URL` and `DOHRA_BROWSER_DIRS` point the companion at a test
release and profile; `npm run e2e:update` uses them to update a 0.0.1 install to
0.0.2 through the real Settings page and checks the folder, the reload and the
companion.

## Testing

- **Unit tests** (`npm test`) cover the WebM repair against synthetic EBML: the
  MediaRecorder layout, a known Segment size, an existing Duration, a size field that
  has to widen, Chrome's AlphaMode, a cut-off Tracks element, and malformed input.
  They also cover session naming and formatting, transliteration, finding the playing
  line, and PCM encoding.
- **Companion tests** (`cd companion && go test -race ./...`) cover:
  - the protocol framing and request handling;
  - quiet-point chunking;
  - the engine with a fake Whisper: chunk offsets, language lock, live and idle
    threads, silent streams, failure, resume after a crash, and replacing a finished
    transcript;
  - the store's crash rules: uncommitted and duplicated runs, and a torn last line;
  - the installer's checksum, archive-escape and host-manifest handling.
- **End-to-end** (`npm run e2e`, [scripts/e2e.mjs](scripts/e2e.mjs)) loads the built
  extension into real Chromium and drives it through the popup. It covers six scenarios:
  - a paused video recording with the microphone;
  - a recording ended by closing the tab;
  - a browser killed with `SIGKILL` mid-recording and then recovered;
  - the library listing them;
  - live transcription of a page playing speech (whisper.cpp's public-domain JFK
    sample) through the real companion with the small model. The transcript must
    contain the spoken words, and the session page must show every line, seek on
    click, and filter on search;
  - transcribing a recording again from its session page, after removing its
    transcript.

  It also checks that the popup offers no format, transcript or language choices, and
  that it states what will be recorded.

  The first three use a test page with moving video and a steady tone.

  Each recording is checked for duration, seeking, audible audio, video size, raw-file
  cleanup, and the SHA-256 of the Downloads copy. The Downloads copy is also played
  through GStreamer ([scripts/gst-play.py](scripts/gst-play.py)), because a file Chrome
  plays is not necessarily one a desktop player accepts. That is how the AlphaMode
  problem slipped through the first version.

  Quirks of the test setup:
  - Headless Chromium captures tab audio as silence, so the test runs headful under
    `xvfb-run`.
  - `--use-fake-ui-for-media-stream` breaks tab capture, so the microphone is granted
    through the permissions API instead.
  - A headful popup closes the moment it loses focus. The test therefore writes
    settings straight to storage and uses the popup only for the one click tab capture
    requires, with retries. It also turns off Chrome's download bubble. Rarely, the
    popup still fails to open; the test then saves a screenshot of the whole display to
    `.e2e/popup-failure.png`.
  - The companion is installed into `.e2e-cache/` with `--no-register` and registered
    only with the test profile, so a run never touches the real browser setup.

  CI runs both on every push.

Not covered automatically:
- hearing tab audio through the speakers while recording;
- hour-long recordings, and laptop sleep during a recording;
- transcript quality on Hindi and Hinglish (no suitable public sample yet);
- the Windows and macOS companion builds, which are compiled and vetted in CI but not
  run.

These need a manual check.

## Known limits

- Chromium browsers only. Firefox has no equivalent of `tabCapture` for extensions.
- Duration is measured with `performance.now()`. If the laptop sleeps mid-recording,
  the stored Duration may not match the media exactly. The file still plays.
- Speaker names come only from tiles on screen. Someone speaking while hidden (a
  large meeting showing a few tiles, or a full-screen presentation) is not named,
  and two people talking at once go to whoever spoke longer in that line. Not yet
  checked against a real Meet or Teams meeting.
- Without headphones, the microphone also records the class from the speakers. Echo
  cancellation reduces this but does not remove it. The transcript then repeats
  "Them" lines as "Me".
- With Small and Medium, Hinglish depends on a prompt steering Whisper, not on a
  trained mode (High is trained for it). Its spelling
  varies ("padhenge"/"parhenge"), and a long pure-English stretch may still drift.
  Transcripts made before 0.4 are in Devanagari; the session page's Roman view
  converts them.
- Transcribing an existing recording decodes all of its audio in memory at once.
