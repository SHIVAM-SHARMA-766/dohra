// End-to-end test: drives the real extension in Chromium through the popup, exactly
// as a user would, and checks the recordings it produces.
//
//   npm run build && npm run e2e      (Linux: runs under xvfb-run, no window appears)
//
// Scenarios:
//   1. video + mic, with a pause in the middle, stopped from the popup
//   2. audio only, stopped by closing the recorded tab
//   3. browser killed mid-recording, then recovered by the library on next launch
//
// Each recording is checked for: completed state, a duration that matches the time
// actually recorded (pauses excluded), working seek, audible audio, the expected video
// size, removal of the raw file, and a Downloads copy whose SHA-256 matches.
//
// Environment: CHROME=/path/to/chromium (default /usr/bin/chromium).
//
// Two browser constraints shape this script:
// - Headless Chromium has no audio pipeline, so captured tab audio is pure silence.
//   The browser therefore runs headful; on Linux `npm run e2e` wraps it in xvfb-run.
// - Branded Google Chrome no longer loads unpacked extensions from the command line,
//   so this needs Chromium (or Chrome for Testing).

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

function serve() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(TEST_PAGE);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---- browser ------------------------------------------------------------------------

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    defaultViewport: { width: 1280, height: 720 },
    args: [
      "--autoplay-policy=no-user-gesture-required",
      // A fake microphone. Not --use-fake-ui-for-media-stream: it breaks tab capture
      // ("Requested device not found"); the mic grant goes through the permissions API.
      "--use-fake-device-for-media-stream",
      // GitHub's Ubuntu runners block the user namespaces Chromium's sandbox needs.
      ...(process.env.CI ? ["--no-sandbox"] : []),
    ],
  });
  const id = await browser.installExtension(dist);
  const ext = (await browser.extensions()).get(id);
  if (!ext) throw new Error("extension did not load");
  await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${id}`, ["microphone"]);
  return { browser, ext };
}

/**
 * Opens the toolbar popup on `page`. A headful popup closes whenever it loses focus,
 * so opening is retried a few times before giving up.
 */
async function openPopup(browser, page, ext) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.bringToFront();
      await page.triggerExtensionAction(ext);
      const target = await browser.waitForTarget((t) => t.url().endsWith("/popup.html"), { timeout: 5_000 });
      const popup = await target.asPage();
      await popup.waitForSelector("#idle:not([hidden]), #recording:not([hidden])", { timeout: 5_000 });
      return popup;
    } catch (e) {
      lastError = e;
      await sleep(500);
    }
  }
  throw new Error(`popup did not open: ${lastError?.message}`);
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
async function startRecording(browser, page, ext, control, { title, mode, mic }) {
  const popup = await openPopup(browser, page, ext);
  await popup.$eval("#title", (el, v) => (el.value = v), title);
  await popup.click(`input[name="mode"][value="${mode}"]`);
  const micOn = await popup.$eval("#mic", (el) => el.checked);
  if (micOn !== mic) await popup.click("#mic");
  await popup.click("#start");
  const active = await waitForStatus(control, "recording", 15_000);
  await popup.close().catch(() => {}); // may already have closed itself on blur
  return active.sessionId;
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
  check(r.names.sort().join(",") === "recording.webm,session.json", "raw file replaced by recording", r.names.join(", "));
  if (r.duration === undefined) return;

  const [lo, hi] = expect.durationS;
  check(Number.isFinite(r.duration) && r.duration >= lo && r.duration <= hi, `duration within ${lo}-${hi}s`, `${r.duration.toFixed(2)}s, meta ${(m.durationMs / 1000).toFixed(2)}s`);
  check(Math.abs(r.seekedTo - r.seekTarget) < 0.6, "seeking works", `asked ${r.seekTarget.toFixed(2)}s, got ${r.seekedTo.toFixed(2)}s`);
  check(r.rms > 0.02, "audio is audible", `rms ${r.rms.toFixed(3)}`);
  if (expect.video) check(r.width > 0 && r.width <= 1280 && r.height <= 720, "video within 720p", `${r.width}x${r.height}`);
  else check(r.width === 0, "no video track", `${r.width}x${r.height}`);
  check(/^[0-9a-f]{64}$/.test(m.sha256 ?? ""), "sha256 recorded");

  if (expect.exported) {
    try {
      const copy = await readFile(join(downloads, "Dohra", id, "recording.webm"));
      const hash = createHash("sha256").update(copy).digest("hex");
      check(hash === m.sha256, "Downloads copy matches sha256", `${(copy.length / 1e6).toFixed(2)} MB`);
      const exportedMeta = JSON.parse(await readFile(join(downloads, "Dohra", id, "session.json"), "utf8"));
      check(exportedMeta.id === id, "Downloads has session.json");
    } catch (e) {
      check(false, "Downloads copy exists", e.message);
    }
  }
}

// ---- scenarios ----------------------------------------------------------------------

async function main() {
  await rm(work, { recursive: true, force: true });
  await mkdir(join(profile, "Default"), { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(
    join(profile, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }),
  );
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;

  let { browser, ext } = await launch();
  try {
    console.log("\n1. video + mic, paused midway, stopped from the popup");
    await grantMic(browser, ext);
    const control = await controlPage(browser, ext);
    const page = await browser.newPage();
    await page.goto(url);
    const one = await startRecording(browser, page, ext, control, { title: "E2E video", mode: "video", mic: process.env.E2E_MIC !== "0" });
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
    await verify(browser, ext, one, { endReason: "user", durationS: [11, 13.5], video: true, exported: true });

    console.log("\n2. audio only, stopped by closing the tab");
    const page2 = await browser.newPage();
    await page2.goto(url);
    const two = await startRecording(browser, page2, ext, control, { title: "E2E audio", mode: "audio", mic: false });
    await sleep(7_000);
    await page2.close();
    await waitForStatus(control, null);
    await verify(browser, ext, two, { endReason: "tab-closed", durationS: [6, 8.5], video: false, exported: true });

    console.log("\n3. browser killed mid-recording, recovered on next launch");
    const page3 = await browser.newPage();
    await page3.goto(url);
    const three = await startRecording(browser, page3, ext, control, { title: "E2E crash", mode: "video", mic: false });
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
    await verify(browser, ext, three, { endReason: "recovered", durationS: [5.5, 10.5], video: true, exported: false });

    console.log("\n4. library lists all three");
    const list = await browser.newPage();
    await list.goto(`chrome-extension://${ext.id}/library.html`);
    await list.waitForSelector(".item");
    const titles = await list.$$eval(".item .title", (els) => els.map((e) => e.textContent));
    check(titles.length === 3, "three recordings listed", titles.join(" | "));
    const exported = await readdir(join(downloads, "Dohra"));
    check(exported.length === 2, "two copies in Downloads/Dohra", exported.join(", "));
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
