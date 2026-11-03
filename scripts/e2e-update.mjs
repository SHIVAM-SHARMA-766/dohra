// End-to-end test of updating from Settings: an old Dohra (0.0.1) and an old
// companion are installed, a local stand-in for GitHub publishes 0.0.2, and the
// test clicks "Check for updates", then "Update". It checks that the extension's
// folder was rewritten, that Dohra reloaded as 0.0.2 and said so, and that the
// companion replaced itself.
//
//   npm run build && npm run e2e:update     (Linux: under xvfb-run)
//
// Uses the whisper.cpp download cached by `npm run e2e` in .e2e-cache/ when present;
// otherwise the companion's install downloads it (about 30 MB).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = join(root, ".e2e-update");
const profile = join(work, "profile");
const extDir = join(work, "Dohra"); // where the "user" unzipped the extension
const release = join(work, "release");
const home = join(root, ".e2e-cache", "dohra-home");
const companion = join(home, "bin", "dohra-companion");
const CHROME = process.env.CHROME ?? "/usr/bin/chromium";
const ID = "dkihabdjpgkkichdojcgbplmjkcboipg";
const OLD = "0.0.1";
const NEW = "0.0.2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok, what, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** dist/ as a given version, in dir. */
async function extensionAt(dir, version) {
  await rm(dir, { recursive: true, force: true });
  await cp(join(root, "dist"), dir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  manifest.version = version;
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function buildCompanion(out, version) {
  run("go", ["build", "-ldflags", `-X main.version=${version}`, "-o", out, "."], { cwd: join(root, "companion") });
}

const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

/** A stand-in for github.com's releases: /latest redirects to the tag, files are under /download/<tag>/. */
async function serveRelease(files) {
  const sums = (await Promise.all(Object.entries(files).map(async ([name, path]) => `${await sha256(path)}  ${name}`))).join("\n") + "\n";
  const prefix = `/releases/download/v${NEW}/`;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/releases/latest") {
      res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/releases/tag/v${NEW}` }).end();
      return;
    }
    const name = req.url.startsWith(prefix) ? decodeURIComponent(req.url.slice(prefix.length)) : "";
    if (name === "SHA256SUMS") return res.end(sums);
    if (files[name]) return res.end(await readFile(files[name]));
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function main() {
  await rm(work, { recursive: true, force: true });
  await mkdir(release, { recursive: true });

  // The release: the current build as 0.0.2, and a companion that says 0.0.2.
  await extensionAt(join(release, "dist"), NEW);
  execFileSync("zip", ["-qr", join(release, "dohra-extension.zip"), "."], { cwd: join(release, "dist") });
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  const companionAsset = `dohra-companion-${process.platform}-${arch}`;
  buildCompanion(join(release, companionAsset), NEW);
  const server = await serveRelease({
    "dohra-extension.zip": join(release, "dohra-extension.zip"),
    [companionAsset]: join(release, companionAsset),
  });
  const env = {
    ...process.env,
    DOHRA_HOME: home,
    DOHRA_UPDATE_URL: `http://127.0.0.1:${server.address().port}/releases`,
    // Look for the extension in the test profile only, not the browsers of the machine.
    DOHRA_BROWSER_DIRS: profile,
  };

  // What the user has: Dohra 0.0.1 unzipped into a folder, and the old companion.
  await extensionAt(extDir, OLD);
  await writeFile(join(extDir, "notes.txt"), "the user's own file");
  buildCompanion(join(work, "dohra-companion"), OLD);
  run(join(work, "dohra-companion"), ["install", "--no-register"], { env });
  run(companion, ["register", "--browser-dir", profile], { env });
  check(run(companion, ["version"]) === OLD, `companion starts at ${OLD}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    pipe: true,
    protocolTimeout: 60_000,
    enableExtensions: true,
    userDataDir: profile,
    env,
    args: [...(process.env.CI ? ["--no-sandbox"] : [])],
  });
  try {
    const id = await browser.installExtension(extDir);
    check(id === ID, "extension loads with Dohra's ID", id);

    // Chrome writes Preferences (where the companion looks) a little after loading.
    const prefsFile = join(profile, "Default", "Preferences");
    const until = Date.now() + 60_000;
    let recorded = false;
    while (!recorded && Date.now() < until) {
      recorded = await readFile(prefsFile, "utf8").then(
        (p) => JSON.parse(p).extensions?.settings?.[ID]?.path === extDir,
        () => false,
      );
      if (!recorded) await sleep(1000);
    }
    check(recorded, "Chrome records the folder in Preferences");

    // Load unpacked needs Developer mode, and Chrome checks it again when an
    // extension reloads: without it, the updated Dohra would come back disabled.
    const ext = await browser.newPage();
    await ext.goto("chrome://extensions");
    await sleep(1000);
    const devMode = await ext.evaluate(() => {
      const toggle = document
        .querySelector("extensions-manager")
        ?.shadowRoot?.querySelector("extensions-toolbar")
        ?.shadowRoot?.querySelector("#devMode");
      if (toggle && !toggle.checked) toggle.click();
      return toggle?.checked;
    });
    check(devMode === true, "Developer mode is on, as Load unpacked requires");
    await ext.close();

    // A first install opens the setup page; close it so Settings has the focus.
    for (const t of browser.targets()) {
      if (t.url().endsWith("/setup.html")) await (await t.page())?.close();
    }
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${ID}/settings.html`);
    await page.bringToFront();
    await page.$eval("#update-check", (b) => b.click());
    await page.waitForFunction(() => !/Checking/.test(document.getElementById("update-status").textContent), { timeout: 60_000 });
    const found = await page.evaluate(() => ({
      status: document.getElementById("update-status").textContent,
      apply: document.getElementById("update-apply").hidden ? null : document.getElementById("update-apply").textContent,
      why: document.getElementById("update-why").hidden ? "" : document.getElementById("update-why").textContent,
      versions: document.getElementById("versions").textContent,
    }));
    check(found.status.includes(`${NEW} is available`) && found.apply === `Update to ${NEW}`, "Settings offers the update", JSON.stringify(found));
    check(found.versions === `Dohra ${OLD} · companion ${OLD}`, "Settings shows both versions", found.versions);

    // Updating reloads Dohra, which closes this page and opens Settings again.
    const reopened = browser.waitForTarget((t) => t.url() === `chrome-extension://${ID}/settings.html#updates`, { timeout: 60_000 });
    await page.$eval("#update-apply", (b) => b.click());
    const target = await reopened.catch(async (e) => {
      const list = browser.targets().map((t) => `${t.type()} ${t.url()}`).join("\n    ");
      throw new Error(`${e.message}; targets:\n    ${list}`);
    });
    const after = await target.asPage();
    await after.waitForFunction(() => document.getElementById("saved").textContent !== "", { timeout: 10_000 });
    const toast = await after.$eval("#saved", (el) => el.textContent);
    // Settings checks again on its own after an update.
    await after.waitForFunction(() => /Up to date|Could not check/.test(document.getElementById("update-status").textContent), { timeout: 60_000 });
    const now = await after.evaluate(() => ({
      version: chrome.runtime.getManifest().version,
      versions: document.getElementById("versions").textContent,
      status: document.getElementById("update-status").textContent,
    }));
    check(now.version === NEW, `Dohra reloaded as ${NEW}`, now.version);
    check(toast === `Dohra is updated to ${NEW}.`, "Settings says it was updated", toast);
    check(/Up to date/.test(now.status) && now.versions === `Dohra ${NEW} · companion ${NEW}`, "and is now up to date", `${now.status} · ${now.versions}`);

    const manifest = JSON.parse(await readFile(join(extDir, "manifest.json"), "utf8"));
    check(manifest.version === NEW && manifest.key, "the folder holds the new version, key intact", manifest.version);
    check((await readFile(join(extDir, "notes.txt"), "utf8")) === "the user's own file", "other files in the folder are left alone");
    check(run(companion, ["version"]) === NEW, `the companion replaced itself with ${NEW}`);
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
