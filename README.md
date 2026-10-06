# Dohra

Record a class or meeting playing in a browser tab, with its audio and video, and
keep the recording on your own computer.

*Dohra* comes from the Hindi *dohrana*, "to revise". The tool exists because live
classes move faster than notes can be taken. Without a recording, there is nothing to
revise from afterwards.

- **No bot joins the meeting.** Dohra records what your browser is already playing, so
  other participants see no extra attendee.
- **Nothing leaves the machine.** Recordings are written to local disk. There is no
  server and no account.
- **Works with any site.** Google Meet, Zoom's web client, Teams on the web, YouTube
  Live, or a course's own player all work, because Dohra captures the tab and not a
  particular platform.

## Status

**Stage 1 — recording — is done.** Later stages build on the same session format:

| Stage | What | Status |
|---|---|---|
| 1 | Record a tab's audio and video locally, browse and play recordings | Done |
| 2 | Transcript after the class (Hindi, English, Hinglish) with "me / them" labels | Planned |
| 3 | Plain-English meaning of each line, unfinished sentences completed, summary | Planned |
| 4 | Live transcript in a side panel, with a hotkey to hide it while screen sharing | Planned |
| 5 | Desktop apps (e.g. the Zoom app) as well as browser tabs | Planned |

## Install

Dohra runs in Chromium-based browsers: **Chrome, Edge and Brave**, on Linux, Windows or
macOS. It is not on the Chrome Web Store; you load it yourself.

1. Download `dohra-<version>.zip` from this repository's
   [Releases](../../releases) page, and unzip it somewhere permanent. The browser loads
   the extension from that folder every time it starts, so don't delete the folder.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the unzipped folder.
5. Pin Dohra to the toolbar from the puzzle-piece menu so it is one click away.

To update, unzip the new release over the same folder and press the reload icon on
Dohra's card in `chrome://extensions`. Recordings are kept across updates. They are
lost if the extension is *removed*, unless they were copied to Downloads (see below).

**From source** (needs Node.js 20.19 or later):

```sh
gh repo clone SHIVAM-SHARMA-766/dohra && cd dohra
npm ci && npm run build      # then load the dist/ folder as above
```

## Use

1. Open the class in a tab.
2. Click the Dohra icon. Choose **Audio + video** or **Audio only**, and a quality
   (720p by default, about 560 MB per hour).
3. Press **Start recording**. The toolbar icon shows **REC** while recording.
4. **Pause** and **Stop** are in the same popup. `Alt+Shift+R` starts or stops
   recording without opening it.

Closing the tab also stops the recording and saves it. You can keep using other tabs
while recording.

**Your own voice.** Tick **Include my microphone** to record yourself as well. The first
time, the popup links to a page where the browser asks for microphone access. Use
headphones if you can; otherwise the microphone also picks up the class from your
speakers.

### Where recordings go

- **The library.** Click **Library** in the popup to list, search, play, save, or
  delete recordings. They are stored inside the browser profile.
- **Downloads/Dohra/.** Each finished recording is also copied to your Downloads folder,
  one folder per session:

  ```
  Downloads/Dohra/2026-10-06_190000_dsa-class/
    recording.webm   the recording (WebM; plays in any browser, VLC, mpv)
    session.json     title, source page, start/end time, duration, SHA-256 of the file
  ```

  This copy survives removing the extension or the browser. You can turn it off in the
  popup. Turning it off saves disk space, but the browser's copy is then the only one.

**If the browser crashes** mid-recording, open the library afterwards. It finishes the
interrupted recording automatically and keeps everything up to the last few seconds.

### Limits worth knowing

- **Browser tabs only.** Classes in a desktop app, such as the Zoom app, are not
  captured yet; open them in the browser instead.
- **Browser pages are off limits.** Pages such as `chrome://` and the Web Store cannot
  be recorded.
- **The recording indicator stays visible.** The browser always shows its own "this tab
  is being shared" indicator, and Dohra cannot hide it.
- **Check your course's terms.** Some course platforms forbid recording in their terms
  of use, so check before relying on Dohra for one.

## Develop

```sh
npm run watch       # rebuild dist/ on change; reload the extension to pick it up
npm run typecheck
npm test            # unit tests (vitest)
npm run e2e         # end-to-end test in real Chromium; Linux, needs xvfb-run
npm run package     # release/dohra-<version>.zip
```

How the pieces fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

**Releasing:** bump `version` in `package.json`, commit, then push a matching tag:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The release workflow builds the zip and attaches it to a GitHub release.
