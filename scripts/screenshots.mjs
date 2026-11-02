// Takes the screenshots in README.md (docs/images/) from the real extension.
//
//   npm run build && npm run e2e      (once: leaves a profile with recordings in .e2e/)
//   xvfb-run -a node scripts/screenshots.mjs
//
// It copies the e2e profile, renames its test recordings to look like classes and
// gives one a Hinglish transcript, so the pictures show what a user would see. The
// e2e profile is left untouched. Light theme, 1280×800.

import { spawnSync } from "node:child_process";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs", "images");
const profile = join(root, ".e2e", "screenshot-profile");
const CHROME = process.env.CHROME ?? "/usr/bin/chromium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TITLES = {
  "E2E transcript": "DSA class — Graphs and BFS",
  "E2E video": "Physics — Electrostatics, lecture 4",
  "E2E meeting": "Weekly doubt session",
  "E2E tab closed": "Maths — Integration practice",
  "E2E crash": "Chemistry — Organic basics",
};

const DEMO_LINES = [
  ["them", "Achchha to students, aaj ham binary search tree ke baare mein padhenge."],
  ["them", "Dekho, har node ke left mein chhoti value hoti hai aur right mein badi value."],
  ["them", "Agar aapko doubt hai to chat mein puchh lena, theek hai?"],
  ["me", "Sir, insertion ka time complexity kya hoga?"],
  ["them", "Good question. Average case mein log n hota hai, worst case mein n."],
  ["them", "Worst case tab aata hai jab tree skewed ho jaata hai, matlab ek line ban jaati hai."],
  ["me", "To usko balance kaise karte hain?"],
  ["them", "Uske liye AVL tree ya red-black tree use karte hain. Woh next class mein dekhenge."],
  ["them", "Ab BFS dekhte hain. BFS mein ham level by level traverse karte hain, queue use karke."],
  ["them", "Pehle source node ko queue mein daalo, phir uske saare neighbours, aur aise hi aage."],
];

await rm(profile, { recursive: true, force: true });
await cp(join(root, ".e2e", "profile"), profile, { recursive: true });
await mkdir(out, { recursive: true });

async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    env: { ...process.env, DOHRA_HOME: join(root, ".e2e-cache", "dohra-home") },
    defaultViewport: { width: 1280, height: 800 },
    args: ["--hide-scrollbars", "--disable-features=DownloadBubble,DownloadBubbleV2"],
  });
  const id = await browser.installExtension(join(root, "dist"));
  await browser.defaultBrowserContext().overridePermissions(`chrome-extension://${id}`, ["microphone"]);
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  return { browser, page, base: `chrome-extension://${id}/` };
}

let page;
async function shot(name, { width = 1280, height = 800, fullPage = false } = {}) {
  await page.setViewport({ width, height });
  await sleep(1500);
  await page.screenshot({ path: join(out, `${name}.png`), fullPage });
  console.log(`docs/images/${name}.png`);
}

/** Draws red boxes (x, y, width, height) on a screenshot, to point at what to click. */
function mark(name, boxes) {
  const file = join(out, `${name}.png`);
  const draw = boxes.map(([x, y, w, h]) => `roundrectangle ${x},${y} ${x + w},${y + h} 8,8`).join(" ");
  spawnSync("convert", [file, "-fill", "none", "-stroke", "#e5383b", "-strokewidth", "4", "-draw", draw, file]);
}

// ---- setup, before the companion is installed: hide its registration ----
const hosts = join(profile, "NativeMessagingHosts");
await rename(hosts, hosts + ".off");
let browser;
let base;
({ browser, page, base } = await launch());
await page.goto(base + "setup.html");
await shot("02-setup-companion", { height: 900 });
await browser.close();
await rename(hosts + ".off", hosts);

({ browser, page, base } = await launch());

// ---- demo data ----
await page.goto(base + "library.html");
const demoId = await page.evaluate(
  async (titles, lines) => {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle("sessions");
    const write = async (dir, name, value) => {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(JSON.stringify(value, null, 2));
      await w.close();
    };
    let demo = null;
    for await (const [name, handle] of sessions.entries()) {
      const meta = JSON.parse(await (await (await handle.getFileHandle("session.json")).getFile()).text());
      if (meta.endReason === "imported") {
        await sessions.removeEntry(name, { recursive: true });
        continue;
      }
      if (titles[meta.title]) {
        if (meta.title === "E2E transcript") demo = name;
        meta.title = titles[meta.title];
        await write(handle, "session.json", meta);
      }
    }
    const dir = await sessions.getDirectoryHandle(demo);
    await write(dir, "transcript.json", {
      schema: 1,
      sessionId: demo,
      state: "complete",
      model: "large",
      language: "hinglish",
      error: null,
      updatedAt: new Date().toISOString(),
      lines: lines.map(([speaker, text], i) => ({ speaker, startMs: i * 2400, endMs: i * 2400 + 2300, text, lang: "hinglish" })),
    });
    await chrome.storage.session.remove(["transcripts", "active", "lastError"]);
    // The e2e test leaves the microphone switch on; show a fresh install's popup.
    await chrome.storage.local.set({ settings: { micSwitchInPopup: false, mic: true, autoExport: true } });
    return demo;
  },
  TITLES,
  DEMO_LINES,
);

// ---- chrome://extensions with Developer mode on ----
await page.goto("chrome://extensions");
await sleep(1000);
await page.evaluate(() => {
  const toggle = document
    .querySelector("extensions-manager")
    ?.shadowRoot?.querySelector("extensions-toolbar")
    ?.shadowRoot?.querySelector("#devMode");
  if (toggle && !toggle.checked) toggle.click();
});
// The Load unpacked bar appears once the page reloads with Developer mode on.
await page.reload();
await sleep(1000);
await shot("01-chrome-extensions");
mark("01-chrome-extensions", [
  [1122, 12, 154, 32], // Developer mode
  [20, 62, 131, 43], // Load unpacked
]);

// ---- setup ----
await page.goto(base + "setup.html");
await shot("03-setup-model", { fullPage: true });

// ---- popup: ready, and recording ----
const tab = await browser.newPage();
await tab.goto("data:text/html,<title>DSA class</title>");
await page.bringToFront();
await page.goto(base + "popup.html");
await page.waitForSelector("#idle:not([hidden])");
await page.$eval("#title", (el) => (el.value = "DSA class — Graphs and BFS"));
await shot("04-popup", { width: 340, height: 470 });
await page.evaluate(() =>
  chrome.storage.session.set({
    active: {
      sessionId: "demo",
      title: "DSA class — Graphs and BFS",
      tabId: 1,
      mode: "video",
      status: "recording",
      progress: { durationMs: 2537000, bytes: 912e6, paused: false, at: Date.now() },
      mic: { recorded: true, meeting: false, manual: false },
    },
    transcripts: { demo: { state: "live", receivedMs: 2537000, doneMs: 2290000, error: null } },
  }),
);
await shot("05-popup-recording", { width: 340, height: 470 });
await page.evaluate(() => chrome.storage.session.remove(["active", "transcripts"]));
await tab.close();

// ---- library, a recording, settings ----
await page.goto(base + "library.html");
await shot("06-library");
await page.goto(`${base}session.html?id=${encodeURIComponent(demoId)}`);
await shot("07-session");
await page.goto(base + "settings.html");
await shot("08-settings", { fullPage: true });

await browser.close();
await rm(profile, { recursive: true, force: true });
