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

**Stages 1 and 2 — recording and transcripts — are done.** Later stages build on the
same session format:

| Stage | What | Status |
|---|---|---|
| 1 | Record a tab's audio and video locally, browse and play recordings | Done |
| 2 | Transcript made on this computer while the class runs (Hindi, English, Hinglish), "me / them" labels, written as Roman-script Hinglish | Done |
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

**From source** (needs Node.js 20.19 or later, and Go 1.26 for the companion):

```sh
gh repo clone SHIVAM-SHARMA-766/dohra && cd dohra
npm ci && npm run build      # then load the dist/ folder as above
cd companion && go build -o dohra-companion . && ./dohra-companion install
```

### First-run setup

Installing Dohra opens its **setup page**, which walks through three steps and ticks
each off by itself:

1. **Allow the microphone**, so your own questions are recorded too.
2. **Install the companion**, `dohra-companion`: a small program (about 40 MB with
   [whisper.cpp](https://github.com/ggml-org/whisper.cpp)) that makes transcripts on
   this computer. The browser starts it when needed, and nothing is uploaded. The page
   shows the commands for your system:

   ```sh
   # Linux (x86-64); on macOS run `brew install whisper-cpp` first and pick the darwin build
   gh release download --repo SHIVAM-SHARMA-766/dohra --pattern dohra-companion-linux-amd64 --output dohra-companion
   chmod +x dohra-companion && ./dohra-companion install

   # Windows (PowerShell)
   gh release download --repo SHIVAM-SHARMA-766/dohra --pattern dohra-companion-windows-amd64.exe --output dohra-companion.exe
   .\dohra-companion.exe install
   ```

   `install` downloads whisper.cpp and the voice detector, checks every file against a
   pinned SHA-256, and registers itself with Chrome, Chromium, Brave and Edge.
3. **Choose a speech model**, downloaded from the page with a progress bar:

   | Model | Download | On a 6-core laptop |
   |---|---|---|
   | **Small** | 190 MB | Keeps up with any class; more mistakes, especially in Hindi |
   | **Medium** | 540 MB | Keeps up; the transcript is ready a few minutes after class |
   | **High** (Hindi2Hinglish) | 575 MB | Clearly best for Hindi and Hinglish; ready about 15 minutes after an hour-long class |

   The page recommends Medium for computers with 8 or more CPU threads, and Small
   otherwise.

Models are managed only in Dohra: **Settings → Speech model** downloads more of them,
switches between installed ones, and removes those not in use. A switch applies to
everything not transcribed yet, including a class in progress. A download that is
interrupted continues where it stopped.

Without the companion, Dohra still records, but there is no transcript until it is set
up. `dohra-companion status` shows what is installed; `dohra-companion uninstall --purge` removes it all.

## Use

1. Open the class in a tab.
2. Click the Dohra icon, and press **Start recording**. The toolbar icon shows **REC**
   while recording.
3. **Pause** and **Stop** are in the same popup. `Alt+Shift+R` starts or stops
   recording without opening it.

Every recording is the same, so there is nothing to choose:

- **audio and video**, at your screen's full resolution — about 1.2 GB per hour at
  1920×1080;
- **your microphone**;
- **a transcript**, written as Hinglish: Hindi in Roman script ("theek hai"), English
  as English.

The popup shows exactly what will be recorded before you start.
Closing the tab also stops the recording and saves it. You can keep using other tabs
while recording.

**Your microphone** is part of every recording. The first time, the popup asks you to
allow microphone access, and **Start** stays disabled until you do. To be able to leave
the microphone out of some recordings, turn on *Show a microphone switch in the
quick-start popup* on Dohra's **Settings** page (linked from the popup and the
library). The popup then shows **Include my microphone**. Use headphones if you can;
otherwise the microphone also picks up the class from your speakers.

**Muting.** In Google Meet, Microsoft Teams, Zoom and Webex on the web, Dohra follows
the meeting's mute: while you are muted there, your microphone is silent in the
recording and the transcript too. On any site, **Mute** in the popup (while recording)
does the same, whatever the meeting says.

**Transcripts** are made while you record, by the companion, in Roman-script
Hinglish, so a class can move freely between Hindi and English.
The popup shows how far the transcript has got. If the companion is not installed or
not ready, the class is still recorded, and the popup says the transcript will be
missing; it can be made later from the recording's page.

**Import video** in the library adds a file you already have, such as a class
downloaded earlier or an old Dohra recording, in any format the browser plays (MP4,
WebM, MP3, M4A, WAV). It is copied into Dohra and transcribed straight away. Keep
its page open until the audio has been sent; after that the companion carries on
by itself.

While a transcript is being made, the recording's page shows a percentage and a
progress bar, and lines appear as each part (about two minutes of audio) finishes.
The library shows the same percentage.

Open a recording from the library to see it with its transcript:

- Click any line to jump the recording to that moment; the line being played is
  highlighted and kept in view (untick **Follow** to scroll freely).
- **Search** finds a word in either script — `padhenge` finds `पढ़ेंगे`.
- Transcripts made before 0.4 are in Devanagari; for those, switch between
  **देवनागरी** and **Roman** (a mechanical transliteration).
- Lines are marked **Me** (your microphone) or **Them** (the tab).
- **Download transcript (.txt)** saves it as plain text with timestamps.

A recording made while the companion was missing can be transcribed afterwards from
its page with **Transcribe this recording**.

### Where recordings go

- **The library.** Click **Library** in the popup to list, search, open, save, or
  delete recordings. They are stored inside the browser profile.
- **Downloads/Dohra/.** Each finished recording is also copied to your Downloads folder,
  one folder per session:

  ```
  Downloads/Dohra/2026-10-06_190000_dsa-class/
    recording.webm   the recording (WebM; plays in any browser, VLC, mpv)
    session.json     title, source page, start/end time, duration, SHA-256 of the file
    transcript.json  timestamped lines with speaker, once transcribed
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
- **Transcripts are only as good as the model.** Expect misheard names and terms,
  especially with the small model and in Hindi. The recording is always there to check
  against: click the line.
- **Upgrading from 0.1.** Remove Dohra in `chrome://extensions` and load it again with
  **Load unpacked**; reloading is not enough. Since 0.2 the extension's ID is fixed so
  the companion can trust it, and an installed 0.1 keeps its old ID until removed. The
  library then starts empty; recordings made with 0.1 remain in `Downloads/Dohra/`.

## Develop

```sh
npm run watch       # rebuild dist/ on change; reload the extension to pick it up
npm run typecheck
npm test            # unit tests (vitest)
npm run e2e         # end-to-end test in real Chromium; Linux, needs xvfb-run and Go
npm run package     # release/dohra-<version>.zip

cd companion && go test ./...   # the companion
```

How the pieces fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

**Releasing:** bump `version` in `package.json`, commit, then push a matching tag:

```sh
git tag v0.3.0 && git push origin v0.3.0
```

The release workflow builds the extension zip and the companion for Linux, Windows and
macOS, and attaches them to a GitHub release with their checksums.
