// End-to-end test: drives the real extension in Chromium through the popup, exactly
// as a user would, and checks the recordings it produces.
//
//   npm run build && npm run e2e      (Linux: runs under xvfb-run, no window appears)
//
// Scenarios:
//   0. first-run setup page: microphone and companion shown as done, then the Small
//      speech model downloaded from the page and made active
//   1. video + mic, with a pause in the middle, stopped from the popup; two moments
//      bookmarked (a double press counts once), saved and copied to Downloads
//   1b. a meeting page at meet.google.com (served locally): muting in the meeting,
//      and in Dohra, silences the recorded microphone; who is speaking is read from
//      the participant tiles, and the transcript's lines carry that name
//   2. stopped by closing the recorded tab, with transcripts off (recorder only)
//   3. browser killed mid-recording, then recovered by the library on next launch
//   4. the library lists them all
//   5. live transcription of a speech page through the companion, then the session
//      page: every line shown, clicking a line seeks, search filters, subtitles
//      download; and the library's search finds the line and plays from it
//   6. transcribing a recording again from its session page, after its transcript
//      is removed
//   7. importing an audio file from disk: stored, opened, and transcribed with a
//      visible percentage
//   8. freeing up space: a recording's video leaves the browser once its Downloads
//      copy is verified, and its page points to Downloads instead
//
// Each recording is checked for: completed state, a duration that matches the time
// actually recorded (pauses excluded), working seek, audible audio, the expected video
// size, removal of the raw file, a Downloads copy whose SHA-256 matches, and playback
// in GStreamer (what GNOME Videos uses), since a file Chrome plays is not necessarily
// one a desktop player accepts.
//
// Environment: CHROME=/path/to/chromium (default /usr/bin/chromium). The GStreamer
// check is skipped when its Python bindings are missing, unless REQUIRE_GSTREAMER=1
// (set on CI). Scenarios 0, 5 and 6 build the companion with Go and install it into
// .e2e-cache/; the Small model (about 200 MB) is downloaded by scenario 0 through the
// setup page, once, then kept in the cache as a complete partial download that the
// page "resumes". E2E_TRANSCRIBE=0 skips them. The companion is registered only with
// the test profile.
//
// Two browser constraints shape this script:
// - Headless Chromium has no audio pipeline, so captured tab audio is pure silence.
//   The browser therefore runs headful; on Linux `npm run e2e` wraps it in xvfb-run.
// - Branded Google Chrome no longer loads unpacked extensions from the command line,
//   so this needs Chromium (or Chrome for Testing).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const work = join(root, ".e2e");
const profile = join(work, "profile");
const downloads = join(work, "downloads");
const CHROME = process.env.CHROME ?? "/usr/bin/chromium";
const TRANSCRIBE = process.env.E2E_TRANSCRIBE !== "0";
const cache = join(root, ".e2e-cache");
const dohraHome = join(cache, "dohra-home");
const companionBin = join(work, "dohra-companion");
// Public-domain speech sample from the whisper.cpp repository: "...ask not what your
// country can do for you, ask what you can do for your country."
const JFK = {
  url: "https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/samples/jfk.wav",
  sha256: "59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e",
  path: join(cache, "jfk.wav"),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(ok, label, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---- a page worth recording: moving picture, steady tone ----------------------------

const TEST_PAGE = `<!doctype html><title>Test class</title>
<body style="margin:0;background:#123">
<canvas id="c" width="1280" height="720" style="width:100vw;height:100vh"></canvas>
<script>
  const ctx = document.getElementById("c").getContext("2d");
  let frame = 0;
  (function draw() {
    frame++;
    ctx.fillStyle = "#123"; ctx.fillRect(0, 0, 1280, 720);
    ctx.fillStyle = "#fc0"; ctx.fillRect((frame * 8) % 1280, 300, 120, 120);
    ctx.fillStyle = "#fff"; ctx.font = "64px sans-serif"; ctx.fillText("frame " + frame, 40, 100);
    requestAnimationFrame(draw);
  })();
  const audio = new AudioContext();
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  gain.gain.value = 0.3;
  osc.frequency.value = 440;
  osc.connect(gain).connect(audio.destination);
  osc.start();
</script>`;

const SPEECH_PAGE = `<!doctype html><title>Speech class</title>
<body style="margin:0;background:#123;color:#fff;font:32px sans-serif">
<p>Speech</p><audio src="/jfk.wav" autoplay loop></audio>`;

// A stand-in for Google Meet: its microphone button, as its labels and data-is-muted
// read, and participant tiles (data-participant-id) whose sound indicator moves while
// that person talks. Asha talks the whole time (the speech playing is "hers"), Rahul
// is silent, and the third tile is your own.
const MEET_PAGE = `<!doctype html><title>Meet – e2e</title>
<body style="margin:0;background:#202124;color:#fff;font:24px sans-serif"><p>Meeting</p>
<button id="mic" data-is-muted="false" aria-label="Turn off microphone (ctrl + d)">mic</button>
<button aria-label="Turn off camera (ctrl + e)">cam</button>
<style>.tile{display:inline-block;width:240px;height:140px;margin:8px;background:#3c4043}.bars{width:20px;height:20px}</style>
<div data-participant-id="spaces/e2e/devices/1" class="tile"><div class="bars a"></div><i>more_vert</i><span class="notranslate">Asha Verma</span></div>
<div data-participant-id="spaces/e2e/devices/2" class="tile"><div class="bars a"></div><span class="notranslate">Rahul K</span></div>
<div data-participant-id="spaces/e2e/devices/3" class="tile"><div class="bars a"></div><span class="notranslate">Shivam (You)</span></div>
<audio src="/jfk.wav" autoplay loop></audio>
<script>
  const bars = document.querySelector('[data-participant-id$="/1"] .bars');
  setInterval(() => (bars.className = bars.className === "bars a" ? "bars b" : "bars a"), 120);
  const b = document.getElementById("mic");
  b.onclick = () => {
    const muted = b.dataset.isMuted !== "true";
    b.dataset.isMuted = String(muted);
    b.setAttribute("aria-label", muted ? "Turn on microphone (ctrl + d)" : "Turn off microphone (ctrl + d)");
  };
</script>`;

/**
 * Serves MEET_PAGE over HTTPS for meet.google.com, which Chrome only loads over HTTPS
 * (it is on the HSTS preload list). The certificate is made for the test, and Chrome
 * trusts its key through --ignore-certificate-errors-spki-list, so the page counts as
 * properly secure. Plain --ignore-certificate-errors would not do: the page would load
 * as insecure, and the toolbar popup would not open over it.
 */
async function serveMeet() {
  const key = join(work, "meet-key.pem");
  const cert = join(work, "meet-cert.pem");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
    "-subj", "/CN=meet.google.com", "-addext", "subjectAltName=DNS:meet.google.com"]);
  const pub = spawnSync("openssl", ["x509", "-in", cert, "-pubkey", "-noout"]).stdout;
  const der = spawnSync("openssl", ["pkey", "-pubin", "-outform", "der"], { input: pub }).stdout;
  spki = createHash("sha256").update(der).digest("base64");
  const server = https.createServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    if (req.url === "/jfk.wav") {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(await readFile(JFK.path));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(MEET_PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function serve() {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/jfk.wav") {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(await readFile(JFK.path));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/speech" ? SPEECH_PAGE : TEST_PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---- companion ----------------------------------------------------------------------

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout ?? ""}${r.stderr ?? String(r.error ?? "")}`);
  }
  return r.stdout;
}

async function fetchVerified({ url, sha256, path }) {
  try {
    if (createHash("sha256").update(await readFile(path)).digest("hex") === sha256) return;
  } catch {}
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(data).digest("hex");
  if (got !== sha256) throw new Error(`${url}: sha256 ${got}, want ${sha256}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/**
 * Builds and installs the companion without a speech model, as a user's first
 * install is, and registers it with the test profile only.
 */
async function setupCompanion() {
  // Stamped with the extension's version, as a release build is, so pages show a real version.
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  run("go", ["build", "-ldflags", `-X main.version=${version}`, "-o", companionBin, "."], { cwd: join(root, "companion") });
  const env = { ...process.env, DOHRA_HOME: dohraHome };
  // Undo the previous run's model choice; a cached model becomes a finished partial download.
  await rm(join(dohraHome, "config.json"), { force: true });
  for (const name of await readdir(join(dohraHome, "models")).catch(() => [])) {
    if (name.startsWith("ggml-") && !name.includes("silero") && !name.endsWith(".part")) {
      await rename(join(dohraHome, "models", name), join(dohraHome, "models", name + ".part"));
    }
  }
  run(companionBin, ["install", "--no-register"], { env });
  run(companionBin, ["register", "--browser-dir", profile], { env });
  await fetchVerified(JFK);
}

// ---- browser ------------------------------------------------------------------------

let meetPort = 0;
let spki = "";

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    protocolTimeout: 30_000, // fail fast instead of hanging on a popup that closed
    headless: false,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    env: { ...process.env, DOHRA_HOME: dohraHome }, // inherited by the companion
    defaultViewport: { width: 1280, height: 720 },
    args: [
      "--autoplay-policy=no-user-gesture-required",
      // A fake microphone. Not --use-fake-ui-for-media-stream: it breaks tab capture
      // ("Requested device not found"); the mic grant goes through the permissions API.
      "--use-fake-device-for-media-stream",
      // Chrome's download bubble pops open after each download and takes focus,
      // which closes the extension popup the next scenario is trying to open.
      "--disable-features=DownloadBubble,DownloadBubbleV2",
      // meet.google.com is served locally (serveMeet), with a certificate trusted by key.
      `--host-resolver-rules=MAP meet.google.com 127.0.0.1:${meetPort}`,
      `--ignore-certificate-errors-spki-list=${spki}`,
      // GitHub's Ubuntu runners block the user namespaces Chromium's sandbox needs.
      ...(process.env.CI ? ["--no-sandbox"] : []),
    ],
  });
  const id = await browser.installExtension(dist);
  const ext = (await browser.extensions()).get(id);
  if (!ext) throw new Error("extension did not load");
  await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${id}`, ["microphone"]);
  // A first install opens the setup page. Close it: a stray tab can take focus from the popup.
  const setupTab = await browser
    .waitForTarget((t) => t.url() === `chrome-extension://${id}/setup.html`, { timeout: 5_000 })
    .catch(() => null);
  if (setupTab) await (await setupTab.page())?.close();
  return { browser, ext, openedSetup: !!setupTab };
}

/**
 * Opens the toolbar popup on `page`. A headful popup closes whenever it loses focus,
 * so opening is retried a few times before giving up.
 */
async function openPopup(browser, page, ext) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await page.bringToFront();
    // Under xvfb there is no window manager to hand out focus, and bringToFront does
    // not always give the window X focus; a click in the page's corner does.
    await page.mouse.click(2, 2).catch(() => {});
    // The action is ignored while the window is still taking focus.
    await sleep(500 * attempt);
    await page.triggerExtensionAction(ext);
    const target = await browser.waitForTarget((t) => t.url().endsWith("/popup.html"), { timeout: 8_000 }).catch((e) => {
      lastError = e;
      return null;
    });
    if (!target) continue; // nothing opened: clicking again is safe
    // The popup exists. Clicking the action again would close it, so wait for its
    // page instead; asPage() fails while the frame is still being created.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        const popup = await target.asPage();
        await popup.waitForSelector("#idle:not([hidden]), #recording:not([hidden])", { timeout: 3_000 });
        return popup;
      } catch (e) {
        lastError = e;
        await sleep(200);
      }
    }
  }
  // Browser UI (bubbles, prompts) is invisible to page screenshots; grab the whole display.
  spawnSync("import", ["-window", "root", join(work, "popup-failure.png")]);
  const cdp = await browser.target().createCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets");
  const targets = targetInfos.map((t) => `${t.type} ${t.url} "${t.title}" attached=${t.attached}`);
  throw new Error(`popup did not open: ${lastError?.message}\n  targets: ${targets.join("\n           ")}`);
}

async function grantMic(browser, ext) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${ext.id}/permissions.html`);
  await page.waitForFunction(() => document.getElementById("status").dataset.state);
  if (await page.$eval("#allow", (el) => !el.hidden)) await page.click("#allow");
  await page.waitForFunction(() => document.getElementById("status").dataset.state === "granted", { timeout: 10_000 });
  await page.close();
}

/**
 * Starts from the popup, since tab capture needs the user's click. Everything after
 * that goes through `control`, an extension page: a popup closes as soon as it loses
 * focus, so it cannot be relied on to stay open. The page sends the same messages the
 * popup's buttons do.
 */
async function startRecording(browser, page, ext, control, { title, mic }) {
  // Settings go straight into storage: every interaction with a headful popup is a
  // chance for it to lose focus and close mid-call, so the popup is used only for
  // the click that tab capture requires. The microphone is always recorded unless
  // the popup switch is enabled, so turning it off means enabling that too.
  await control.evaluate(
    async (patch) => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, ...patch } });
    },
    mic ? { micSwitchInPopup: false } : { micSwitchInPopup: true, mic: false },
  );
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const popup = await openPopup(browser, page, ext);
      await popup.evaluate((t) => {
        document.getElementById("title").value = t;
        document.getElementById("start").click();
      }, title);
      const active = await waitForStatus(control, "recording", 15_000);
      await popup.close().catch(() => {}); // may already have closed itself on blur
      return active.sessionId;
    } catch (e) {
      lastError = e;
      const { active } = await state(control);
      if (active?.status === "recording") return active.sessionId; // started; only the popup went away
      await sleep(500);
    }
  }
  throw lastError;
}

async function controlPage(browser, ext) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${ext.id}/library.html`);
  return page;
}

async function state(control) {
  return control.evaluate(() => chrome.storage.session.get(["active", "lastError"]));
}

/** Waits for the active recording to reach `status`, or (status null) for none. */
async function waitForStatus(control, status, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const { active, lastError } = await state(control);
    if (status === null ? !active : active?.status === status) return active;
    if (lastError && status !== null) throw new Error(`recording failed: ${lastError}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}: ${JSON.stringify({ active, lastError })}`);
    await sleep(250);
  }
}

async function command(control, type) {
  const reply = await control.evaluate((type) => chrome.runtime.sendMessage({ target: "background", type }), type);
  if (!reply?.ok) throw new Error(`${type} failed: ${reply?.error}`);
}

// ---- inspecting a recording ---------------------------------------------------------

async function inspect(browser, ext, id) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${ext.id}/library.html`);
  const result = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id);
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    const meta = JSON.parse(await (await (await dir.getFileHandle("session.json")).getFile()).text());
    if (!names.includes("recording.webm")) return { meta, names };

    const file = await (await dir.getFileHandle("recording.webm")).getFile();
    const video = document.createElement("video");
    video.muted = true;
    video.src = URL.createObjectURL(file);
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error(`media error: ${video.error?.message}`));
    });
    const duration = video.duration;
    const seekTarget = Math.max(0, Math.min(duration - 1.5, 8));
    video.currentTime = seekTarget;
    await new Promise((resolve) => (video.onseeked = resolve));

    const audio = await new OfflineAudioContext(1, 1, 48_000).decodeAudioData(await file.arrayBuffer());
    const samples = audio.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];

    return {
      meta,
      names,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      seekTarget,
      seekedTo: video.currentTime,
      rms: Math.sqrt(sum / samples.length),
    };
  }, id);
  await page.close();
  return result;
}

async function verify(browser, ext, id, expect) {
  const r = await inspect(browser, ext, id);
  const m = r.meta;
  check(m.state === "complete", "state is complete", m.state + (m.error ? ` (${m.error})` : ""));
  check(m.endReason === expect.endReason, `ended by ${expect.endReason}`, m.endReason);
  check(!m.error, "no warnings", m.error ?? "");
  check(
    !r.names.includes("raw.webm") && r.names.includes("recording.webm") && r.names.includes("session.json"),
    "raw file replaced by recording",
    r.names.join(", "),
  );
  if (r.duration === undefined) return;

  const [lo, hi] = expect.durationS;
  check(Number.isFinite(r.duration) && r.duration >= lo && r.duration <= hi, `duration within ${lo}-${hi}s`, `${r.duration.toFixed(2)}s, meta ${(m.durationMs / 1000).toFixed(2)}s`);
  check(Math.abs(r.seekedTo - r.seekTarget) < 0.6, "seeking works", `asked ${r.seekTarget.toFixed(2)}s, got ${r.seekedTo.toFixed(2)}s`);
  check(r.rms > 0.02, "audio is audible", `rms ${r.rms.toFixed(3)}`);
  // Captured at the tab's size, up to the screen's resolution.
  check(r.width >= 1280 && r.height >= 600 && m.quality === `${r.width}x${r.height}`, "video at the tab's full size", `${r.width}x${r.height}, meta ${m.quality}`);
  check(/^[0-9a-f]{64}$/.test(m.sha256 ?? ""), "sha256 recorded");

  if (expect.exported) {
    try {
      const copy = await readFile(join(downloads, "Dohra", id, "recording.webm"));
      const hash = createHash("sha256").update(copy).digest("hex");
      check(hash === m.sha256, "Downloads copy matches sha256", `${(copy.length / 1e6).toFixed(2)} MB`);
      checkGstreamer(join(downloads, "Dohra", id, "recording.webm"));
      const exportedMeta = JSON.parse(await readFile(join(downloads, "Dohra", id, "session.json"), "utf8"));
      check(exportedMeta.id === id, "Downloads has session.json");
    } catch (e) {
      check(false, "Downloads copy exists", e.message);
    }
  }
}

function checkGstreamer(file) {
  const run = spawnSync("python3", [join(root, "scripts", "gst-play.py"), file], { encoding: "utf8" });
  const output = (run.stdout || run.stderr || String(run.error)).trim();
  if (run.status === 2 && !process.env.REQUIRE_GSTREAMER) {
    console.log(`  - plays in GStreamer — skipped (${output})`);
    return;
  }
  check(run.status === 0, "plays in GStreamer (GNOME Videos)", output);
}

// ---- transcripts --------------------------------------------------------------------

/** Waits for the companion to finish a session, then returns transcript.json. */
async function waitForTranscript(control, id, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const status = await control.evaluate((id) => chrome.storage.session.get("transcripts").then((r) => r.transcripts?.[id]), id);
    if (status?.state === "complete" || status?.state === "failed") break;
    if (Date.now() > deadline) throw new Error(`transcript for ${id} not finished: ${JSON.stringify(status)}`);
    await sleep(500);
  }
  await sleep(500); // the final save follows the status change
  return control.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id);
    return JSON.parse(await (await (await dir.getFileHandle("transcript.json")).getFile()).text());
  }, id);
}

function checkTranscript(t, speaker, durationMs) {
  const text = t.lines.map((l) => l.text).join(" ");
  check(t.state === "complete", "transcript complete", t.state + (t.error ? ` (${t.error})` : ""));
  check(t.lines.length > 0, "transcript has lines", `${t.lines.length} lines, model ${t.model}, language ${t.language}`);
  check(/country/i.test(text), "transcript contains the spoken words", text.slice(0, 90));
  check(t.lines.every((l) => l.speaker === speaker), `every line attributed to "${speaker}"`);
  check(
    t.lines.every((l, i) => l.startMs >= 0 && l.startMs <= durationMs + 1000 && (i === 0 || l.startMs >= t.lines[i - 1].startMs)),
    "timestamps ordered and within the recording",
  );
}

// ---- scenarios ----------------------------------------------------------------------

async function main() {
  await rm(work, { recursive: true, force: true });
  await mkdir(join(profile, "Default"), { recursive: true });
  await mkdir(downloads, { recursive: true });
  if (TRANSCRIBE) await setupCompanion();
  await writeFile(
    join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  );
  const server = await serve();
  const meetServer = await serveMeet();
  meetPort = meetServer.address().port;
  const url = `http://127.0.0.1:${server.address().port}/`;

  let { browser, ext, openedSetup } = await launch();
  try {
    check(openedSetup, "installing opens the setup page");
    await grantMic(browser, ext);
    if (TRANSCRIBE) {
      console.log("\n0. first-run setup: download a speech model from the page");
      const setup = await browser.newPage();
      await setup.goto(`chrome-extension://${ext.id}/setup.html`);
      await setup.waitForSelector('.model[data-model="small"] button', { timeout: 30_000 });
      const before = await setup.evaluate(() => ({
        mic: document.getElementById("step-mic").dataset.done,
        companion: document.getElementById("step-companion").dataset.done,
        model: document.getElementById("step-model").dataset.done,
        models: [...document.querySelectorAll(".model")].map((m) => m.dataset.model).join(","),
      }));
      check(before.mic === "true" && before.companion === "true", "setup shows microphone and companion done", JSON.stringify(before));
      check(before.model === "false" && before.models === "small,medium,large", "setup offers Small, Medium and High", before.models);
      await setup.click("#record-only");
      await setup
        .waitForFunction(async () => (await chrome.storage.local.get("settings")).settings?.transcribe === false, { timeout: 5_000 })
        .catch(() => {});
      const recordOnly = await setup.evaluate(async () => ({
        done: !document.getElementById("done").hidden,
        companionShown: document.getElementById("step-companion").offsetParent !== null,
        transcribe: (await chrome.storage.local.get("settings")).settings?.transcribe,
      }));
      check(recordOnly.done && !recordOnly.companionShown && recordOnly.transcribe === false,
        "choosing to just record skips the transcript steps", JSON.stringify(recordOnly));
      await setup.click("#want-transcripts");
      await setup.waitForFunction(() => document.getElementById("step-companion").offsetParent !== null);
      await setup.$eval('.model[data-model="small"] .model-actions button', (b) => b.click());
      await setup.waitForSelector('.model[data-model="small"][data-state="active"]', { timeout: 900_000 });
      const after = await setup.evaluate(() => ({
        model: document.getElementById("step-model").dataset.done,
        done: !document.getElementById("done").hidden,
      }));
      check(after.model === "true" && after.done, "the downloaded model is in use and setup is complete", JSON.stringify(after));
      await setup.close();
    }

    console.log("\n1. video + mic, paused midway, stopped from the popup");
    const control = await controlPage(browser, ext);
    const page = await browser.newPage();
    await page.goto(url);
    const popup = await openPopup(browser, page, ext);
    const quick = await popup.evaluate(() => ({
      choices: document.querySelectorAll('input[name="mode"], #quality, #language').length,
      transcribe: document.getElementById("transcribe").checked,
      // Rendered visibility, not just the attribute: CSS can override [hidden].
      micSwitchHidden: document.getElementById("mic-switch").offsetParent === null,
      summary: [...document.querySelectorAll("#summary .chip")].map((c) => c.textContent).join(" · "),
    }));
    await popup.close().catch(() => {});
    check(quick.choices === 0 && quick.micSwitchHidden, "quick start offers no format or language choices");
    check(quick.transcribe, "transcripts are on by default");
    check(quick.summary === "Audio + video · Microphone · Transcript", "quick start states what is recorded", quick.summary);
    const one = await startRecording(browser, page, ext, control, { title: "E2E video", mic: process.env.E2E_MIC !== "0" });
    await sleep(6_000);
    await command(control, "bookmark");
    await command(control, "bookmark"); // a double press: one bookmark
    await command(control, "pause");
    await waitForStatus(control, "paused");
    await sleep(4_000);
    await command(control, "resume");
    await waitForStatus(control, "recording");
    await sleep(4_000);
    await command(control, "bookmark");
    const marked = (await state(control)).active?.bookmarks;
    await sleep(2_000);
    await command(control, "stop");
    await waitForStatus(control, null);
    const err1 = (await state(control)).lastError;
    check(!err1, "no error reported", err1 ?? "");
    await verify(browser, ext, one, { endReason: "user", durationS: [11, 13.5], exported: true });
    const bookmarks = await control.evaluate(async (id) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id);
      return JSON.parse(await (await (await dir.getFileHandle("bookmarks.json")).getFile()).text()).bookmarks.map((b) => b.ms);
    }, one).catch((e) => String(e));
    // At about 6 s and 10 s of recorded time: the pause does not count.
    check(
      marked === 2 && Array.isArray(bookmarks) && bookmarks.length === 2 && Math.abs(bookmarks[0] - 6_000) < 1_500 && Math.abs(bookmarks[1] - 10_000) < 1_500,
      "bookmarks saved at the recorded moments, a double press once",
      `${marked} in the popup; ${JSON.stringify(bookmarks)}`,
    );
    const bookmarksCopy = await readFile(join(downloads, "Dohra", one, "bookmarks.json"), "utf8").then((t) => JSON.parse(t).bookmarks.length, () => 0);
    check(bookmarksCopy === 2, "bookmarks copied to Downloads");

    // Let the companion finish scenario 1's transcript first: whisper.cpp takes every
    // core while it works, and a starved browser opens the popup too slowly.
    if (TRANSCRIBE) await waitForTranscript(control, one, 300_000).catch(() => {});

    console.log("\n1b. meeting mute silences the recorded microphone");
    const meet = await browser.newPage();
    await meet.goto("https://meet.google.com/abc-defg-hij");
    const mb = await startRecording(browser, meet, ext, control, { title: "E2E meeting", mic: true });
    const micState = async () => (await state(control)).active?.mic;
    const waitMic = async (want, timeout = 10_000) => {
      const until = Date.now() + timeout;
      let m;
      while (Date.now() < until) {
        m = await micState();
        if (m && Object.entries(want).every(([k, v]) => m[k] === v)) return m;
        await sleep(200);
      }
      return m;
    };
    await sleep(3_000);
    const live = await waitMic({ meeting: false });
    check(live?.recorded === true && live?.meeting === false, "reads the meeting's mic as live", JSON.stringify(live));
    await meet.click("#mic");
    const mutedThere = await waitMic({ meeting: true });
    check(mutedThere?.meeting === true, "muting in the meeting mutes the recorded mic", JSON.stringify(mutedThere));
    await meet.click("#mic");
    await waitMic({ meeting: false });
    const reply = await control.evaluate(() => chrome.runtime.sendMessage({ target: "background", type: "mic-manual", muted: true }));
    const mutedHere = await waitMic({ manual: true });
    check(reply?.ok && mutedHere?.manual === true, "Dohra's own mute works too", JSON.stringify(mutedHere));
    await sleep(2_000);
    await command(control, "stop");
    await waitForStatus(control, null);
    const errMeet = (await state(control)).lastError;
    check(!errMeet, "no error reported", errMeet ?? "");
    await verify(browser, ext, mb, { endReason: "user", durationS: [4, 30], exported: true });
    await meet.close();
    const timeline = await control.evaluate(async (id) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id);
      return JSON.parse(await (await (await dir.getFileHandle("speakers.json")).getFile()).text());
    }, mb).catch((e) => ({ error: String(e) }));
    const speakersCopy = await readFile(join(downloads, "Dohra", mb, "speakers.json"), "utf8").then(() => true, () => false);
    check(speakersCopy, "speakers copied to Downloads");
    const heard = new Set((timeline.events ?? []).flatMap((e) => e.speaking.map((s) => s.name)));
    check(
      heard.has("Asha Verma") && !heard.has("Rahul K") && timeline.events.every((e) => e.tiles === 3),
      "reads who is speaking from the meeting's tiles",
      JSON.stringify([...heard]) + (timeline.error ? ` ${timeline.error}` : ` · ${timeline.events.length} events`),
    );
    if (TRANSCRIBE) {
      const tm = await waitForTranscript(control, mb, 300_000);
      const them = tm.lines.filter((l) => l.speaker === "them");
      check(them.length > 0 && them.every((l) => l.name === "Asha Verma"), "the meeting's lines carry the speaker's name",
        them.map((l) => `${l.name ?? "?"}: ${l.text}`).join(" | "));
    }

    console.log("\n2. stopped by closing the tab, transcripts off (just a recorder)");
    const setTranscribe = (on) =>
      control.evaluate(async (on) => {
        const { settings } = await chrome.storage.local.get("settings");
        await chrome.storage.local.set({ settings: { ...settings, transcribe: on } });
      }, on);
    await setTranscribe(false);
    const page2 = await browser.newPage();
    await page2.goto(url);
    const two = await startRecording(browser, page2, ext, control, { title: "E2E tab closed", mic: false });
    await sleep(7_000);
    await page2.close();
    await waitForStatus(control, null);
    await setTranscribe(true);
    await verify(browser, ext, two, { endReason: "tab-closed", durationS: [6, 8.5], exported: true });
    const twoFiles = (await inspect(browser, ext, two)).names;
    const twoStatus = await control.evaluate((id) => chrome.storage.session.get("transcripts").then((r) => r.transcripts?.[id] ?? null), two);
    check(!twoFiles.includes("transcript.json") && twoStatus === null, "no transcript is made or attempted", twoFiles.join(", "));

    console.log("\n3. browser killed mid-recording, recovered on next launch");
    const page3 = await browser.newPage();
    await page3.goto(url);
    const three = await startRecording(browser, page3, ext, control, { title: "E2E crash", mic: false });
    await sleep(10_000);
    browser.process()?.kill("SIGKILL");
    await sleep(1_000);

    ({ browser, ext } = await launch());
    const lib = await browser.newPage();
    await lib.goto(`chrome-extension://${ext.id}/library.html`);
    await lib.waitForFunction(() => !document.getElementById("notice").hidden, { timeout: 30_000 });
    const notice = await lib.$eval("#notice", (el) => el.textContent);
    check(notice.startsWith("Recovered 1 recording"), "library reports the recovery", notice);
    await lib.close();
    // Everything up to the last flushed chunk (every 3 s) survives.
    await verify(browser, ext, three, { endReason: "recovered", durationS: [5.5, 10.5], exported: false });

    console.log("\n4. library lists all four");
    const list = await browser.newPage();
    await list.goto(`chrome-extension://${ext.id}/library.html`);
    await list.waitForSelector(".item");
    const titles = await list.$$eval(".item .title", (els) => els.map((e) => e.textContent));
    check(titles.length === 4, "four recordings listed", titles.join(" | "));
    const folders = await readdir(join(downloads, "Dohra"));
    const withRecording = [];
    for (const f of folders) {
      if ((await readdir(join(downloads, "Dohra", f))).includes("recording.webm")) withRecording.push(f);
    }
    check(withRecording.length === 3, "three recordings copied to Downloads/Dohra", withRecording.join(", "));

    if (TRANSCRIBE) {
      console.log("\n5. live transcription through the companion, then the session page");
      const control2 = await controlPage(browser, ext); // the first control page died with the old browser
      const speech = await browser.newPage();
      await speech.goto(url + "speech");
      const five = await startRecording(browser, speech, ext, control2, { title: "E2E transcript", mic: false });
      await sleep(25_000);
      await command(control2, "stop");
      await waitForStatus(control2, null);
      const t5 = await waitForTranscript(control2, five, 240_000);
      checkTranscript(t5, "them", 26_000);
      await sleep(1_000);
      try {
        const copy = JSON.parse(await readFile(join(downloads, "Dohra", five, "transcript.json"), "utf8"));
        check(copy.lines.length === t5.lines.length, "transcript copied to Downloads");
      } catch (e) {
        check(false, "transcript copied to Downloads", e.message);
      }

      const sp = await browser.newPage();
      await sp.goto(`chrome-extension://${ext.id}/session.html?id=${five}`);
      await sp.waitForSelector(".line");
      const shown = await sp.$$eval(".line", (els) => els.length);
      check(shown === t5.lines.length, "session page shows every line", `${shown} of ${t5.lines.length}`);
      const last = t5.lines[t5.lines.length - 1];
      await sp.$$eval(".line", (els) => els[els.length - 1].click());
      const seeked = await sp
        .waitForFunction((t) => Math.abs(document.getElementById("media").currentTime - t) < 1.5, { timeout: 5_000 }, last.startMs / 1000)
        .then(() => true, () => false);
      check(seeked, "clicking a line seeks the player to it", `${(last.startMs / 1000).toFixed(1)}s`);
      await sp.type("#search", "country");
      const matches = await sp.$$eval(".line", (els) => els.length);
      const marked = await sp.$$eval(".line mark", (els) => els.length);
      check(matches > 0 && matches <= shown && marked > 0, "search filters and highlights", `${matches} of ${shown} lines`);
      await sp.$eval("#download-srt", (b) => b.click());
      await sp.$eval("#download-vtt", (b) => b.click());
      let srt = "";
      let vtt = "";
      for (let i = 0; i < 20 && (!srt || !vtt); i++) {
        await sleep(500);
        srt = await readFile(join(downloads, `${five}.srt`), "utf8").catch(() => "");
        vtt = await readFile(join(downloads, `${five}.vtt`), "utf8").catch(() => "");
      }
      check(
        /^1\n00:00:\d\d,\d{3} --> 00:00:\d\d,\d{3}\n/.test(srt) && srt.toLowerCase().includes("country") && vtt.startsWith("WEBVTT\n\n"),
        "subtitles download as .srt and .vtt",
        srt.split("\n").slice(0, 3).join(" | "),
      );
      await sp.close();

      // The library searches inside transcripts and plays from the matching line.
      const lib5 = await browser.newPage();
      await lib5.goto(`chrome-extension://${ext.id}/library.html`);
      await lib5.waitForSelector(".item");
      await lib5.type("#search", "country");
      const found = await lib5.waitForSelector(".match", { timeout: 5_000 }).then(() => true, () => false);
      const items = await lib5.$$eval(".item .title", (els) => els.map((e) => e.textContent));
      // The speech also played in the meeting scenario; the tone-only recording has no words.
      check(
        found && items.some((t) => t.startsWith("E2E transcript")) && !items.some((t) => t.startsWith("E2E video")),
        "library search finds the line inside the transcript",
        items.join(" | "),
      );
      if (found) {
        const target = t5.lines.find((l) => l.text.toLowerCase().includes("country"));
        await lib5.evaluate(() => {
          const item = [...document.querySelectorAll(".item")].find((i) => i.querySelector(".title").textContent.startsWith("E2E transcript"));
          item.querySelector(".match").click();
        });
        const played = await lib5
          .waitForFunction((t) => location.pathname.endsWith("/session.html") && Math.abs(document.getElementById("media")?.currentTime - t) < 1.5, { timeout: 10_000 }, target.startMs / 1000)
          .then(() => true, () => false);
        check(played, "and opens the recording at that line", `${(target.startMs / 1000).toFixed(1)}s`);
      }
      await lib5.close();

      console.log("\n6. transcribing again from the session page");
      // Every recording is transcribed now, so remove this one's transcript to get a
      // recording without one, as a recording made without the companion would be.
      await control2.evaluate(async (id) => {
        const root = await navigator.storage.getDirectory();
        const dir = await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id);
        await dir.removeEntry("transcript.json");
        const { transcripts } = await chrome.storage.session.get("transcripts");
        delete transcripts[id];
        await chrome.storage.session.set({ transcripts });
      }, five);
      const sp6 = await browser.newPage();
      await sp6.goto(`chrome-extension://${ext.id}/session.html?id=${five}`);
      const offered = await sp6.waitForSelector("#transcribe:not([hidden])", { timeout: 15_000 }).then(() => true, () => false);
      check(
        offered,
        "session page offers to transcribe",
        offered ? "" : JSON.stringify(await sp6.evaluate(() => ({
          empty: document.getElementById("empty").hidden,
          text: document.getElementById("empty-text").textContent,
          status: document.getElementById("transcript-status").textContent,
          lines: document.querySelectorAll(".line").length,
        }))),
      );
      if (offered) {
        await sp6.click("#transcribe");
        const t6 = await waitForTranscript(control2, five, 240_000);
        checkTranscript(t6, "mixed", 26_000);
        const rendered = await sp6.waitForSelector(".line", { timeout: 10_000 }).then(() => true, () => false);
        check(rendered, "session page shows the new transcript");
      }

      console.log("\n7. importing an audio file from disk, transcribed straight away");
      const libPage = await browser.newPage();
      await libPage.goto(`chrome-extension://${ext.id}/library.html`);
      // Chrome does not load media metadata in a background tab, and the import reads it.
      await libPage.bringToFront();
      const input = await libPage.waitForSelector("#import-file");
      await input.uploadFile(JFK.path);
      // The library copies the file, then moves to its session page.
      const until = Date.now() + 90_000;
      while (!libPage.url().includes("session.html") && Date.now() < until) await sleep(500);
      const seven = new URL(libPage.url()).searchParams.get("id");
      check(
        !!seven,
        "import opens the new session",
        seven ? libPage.url() : JSON.stringify(await libPage.evaluate(() => ({
          box: !document.getElementById("import-progress").hidden,
          text: document.getElementById("import-text").textContent,
          bar: document.getElementById("import-bar").value,
          notice: document.getElementById("notice").textContent,
          visible: document.visibilityState,
        }))),
      );
      if (!seven) throw new Error("import did not open a session");
      const sawPercent = await libPage
        .waitForSelector("#transcript-percent:not([hidden])", { timeout: 60_000 })
        .then(() => true, () => false);
      check(sawPercent, "session page shows transcription progress as a percentage");
      const t7 = await waitForTranscript(control2, seven, 240_000);
      checkTranscript(t7, "mixed", 12_000);
      // Read after transcribing: the session page completes what the import could not read.
      const imported = await libPage.evaluate(async (id) => {
        const root = await navigator.storage.getDirectory();
        const dir = await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id);
        return JSON.parse(await (await (await dir.getFileHandle("session.json")).getFile()).text());
      }, seven);
      check(
        imported.endReason === "imported" && imported.file === "recording.wav" && imported.mode === "audio" && Math.abs(imported.durationMs - 11_000) < 500,
        "imported file stored with its length and format",
        `${imported.file}, ${imported.mode}, ${imported.durationMs} ms`,
      );

      await libPage.close();
    }

    console.log("\n8. freeing up space: the video stays only in Downloads");
    const lib8 = await browser.newPage();
    lib8.on("dialog", (d) => void d.accept());
    await lib8.goto(`chrome-extension://${ext.id}/library.html`);
    await lib8.waitForSelector(".item");
    const freed = await lib8.evaluate(() => {
      const item = [...document.querySelectorAll(".item")].find((i) => i.querySelector(".title").textContent.startsWith("E2E tab closed"));
      const button = item?.querySelector('button[aria-label^="Free up space"]');
      button?.click();
      return !!button;
    });
    check(freed, "the library offers to free up space for a recording copied to Downloads");
    await lib8.waitForFunction(() => [...document.querySelectorAll(".item .tag")].some((t) => t.textContent === "In Downloads only"), { timeout: 10_000 }).catch(() => {});
    const after8 = await lib8.evaluate(async (id) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle("sessions")).getDirectoryHandle(id);
      const names = [];
      for await (const name of dir.keys()) names.push(name);
      const meta = JSON.parse(await (await (await dir.getFileHandle("session.json")).getFile()).text());
      return { names, removed: meta.browserCopyRemovedAt };
    }, two);
    check(!!after8.removed && !after8.names.includes("recording.webm"), "the video left the browser", after8.names.join(", "));
    const stillThere = await readFile(join(downloads, "Dohra", two, "recording.webm")).then((b) => b.length > 0, () => false);
    check(stillThere, "the Downloads copy is untouched");
    await lib8.goto(`chrome-extension://${ext.id}/session.html?id=${two}`);
    const pointed = await lib8
      .waitForFunction(() => !document.getElementById("video-elsewhere").hidden && document.getElementById("media").hidden, { timeout: 10_000 })
      .then(() => lib8.$eval("#video-path", (el) => el.textContent), () => "");
    check(pointed.endsWith(`/${two}/recording.webm`), "its page points to the copy in Downloads", pointed);
    await lib8.close();
  } finally {
    await browser.close().catch(() => {});
    server.close();
    meetServer.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
