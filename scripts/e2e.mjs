// End-to-end test: drives the real extension in Chromium through the popup, exactly
// as a user would, and checks the recordings it produces.
//
//   npm run build && npm run e2e      (Linux: runs under xvfb-run, no window appears)
//
// Scenarios:
//   0. first-run setup page: microphone and companion shown as done, then the Small
//      speech model downloaded from the page and made active
//   1. video + mic, with a pause in the middle, stopped from the popup
//   2. stopped by closing the recorded tab
//   3. browser killed mid-recording, then recovered by the library on next launch
//   4. the library lists them
//   5. live transcription of a speech page through the companion, then the session
//      page: every line shown, clicking a line seeks, search filters
//   6. transcribing a recording again from its session page, after its transcript
//      is removed
//   7. importing an audio file from disk: stored, opened, and transcribed with a
//      visible percentage
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
  run("go", ["build", "-o", companionBin, "."], { cwd: join(root, "companion") });
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
    // The action is ignored while the window is still taking focus.
    await sleep(500);
    await page.triggerExtensionAction(ext);
    const target = await browser.waitForTarget((t) => t.url().endsWith("/popup.html"), { timeout: 5_000 }).catch((e) => {
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
      choices: document.querySelectorAll('input[name="mode"], #quality, #language, #transcribe').length,
      // Rendered visibility, not just the attribute: CSS can override [hidden].
      micSwitchHidden: document.getElementById("mic-switch").offsetParent === null,
      summary: [...document.querySelectorAll("#summary .chip")].map((c) => c.textContent).join(" · "),
    }));
    await popup.close().catch(() => {});
    check(quick.choices === 0 && quick.micSwitchHidden, "quick start offers no format, transcript or language choices");
    check(quick.summary === "Audio + video · Microphone · Transcript", "quick start states what is recorded", quick.summary);
    const one = await startRecording(browser, page, ext, control, { title: "E2E video", mic: process.env.E2E_MIC !== "0" });
    await sleep(6_000);
    await command(control, "pause");
    await waitForStatus(control, "paused");
    await sleep(4_000);
    await command(control, "resume");
    await waitForStatus(control, "recording");
    await sleep(6_000);
    await command(control, "stop");
    await waitForStatus(control, null);
    const err1 = (await state(control)).lastError;
    check(!err1, "no error reported", err1 ?? "");
    await verify(browser, ext, one, { endReason: "user", durationS: [11, 13.5], exported: true });

    console.log("\n2. stopped by closing the tab");
    const page2 = await browser.newPage();
    await page2.goto(url);
    const two = await startRecording(browser, page2, ext, control, { title: "E2E tab closed", mic: false });
    await sleep(7_000);
    await page2.close();
    await waitForStatus(control, null);
    await verify(browser, ext, two, { endReason: "tab-closed", durationS: [6, 8.5], exported: true });

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

    console.log("\n4. library lists all three");
    const list = await browser.newPage();
    await list.goto(`chrome-extension://${ext.id}/library.html`);
    await list.waitForSelector(".item");
    const titles = await list.$$eval(".item .title", (els) => els.map((e) => e.textContent));
    check(titles.length === 3, "three recordings listed", titles.join(" | "));
    const folders = await readdir(join(downloads, "Dohra"));
    const withRecording = [];
    for (const f of folders) {
      if ((await readdir(join(downloads, "Dohra", f))).includes("recording.webm")) withRecording.push(f);
    }
    check(withRecording.length === 2, "two recordings copied to Downloads/Dohra", withRecording.join(", "));

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
      await sp.close();

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
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
