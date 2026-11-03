// Builds the extension into dist/: bundles each entry point and copies static files.
// The manifest version comes from package.json, so there is one place to bump it.
//
//   node scripts/build.mjs           production build
//   node scripts/build.mjs --watch   rebuild on change, with source maps

import { context, build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { watch as watchFiles } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");
const watching = process.argv.includes("--watch");

const entryPoints = {
  background: "src/background/background.ts",
  offscreen: "src/offscreen/offscreen.ts",
  popup: "src/popup/popup.ts",
  library: "src/library/library.ts",
  permissions: "src/permissions/permissions.ts",
  session: "src/session/session.ts",
  setup: "src/setup/setup.ts",
  settings: "src/settings/settings.ts",
  worker: "src/worker/storage-worker.ts",
  "tap-worklet": "src/offscreen/tap-worklet.ts",
  "meeting-mic": "src/content/meeting-mic.ts",
  "meeting-speakers": "src/content/meeting-speakers.ts",
};

const staticFiles = [
  "ui.css",
  "offscreen/offscreen.html",
  "popup/popup.html",
  "popup/popup.css",
  "library/library.html",
  "library/library.css",
  "permissions/permissions.html",
  "session/session.html",
  "session/session.css",
  "setup/setup.html",
  "setup/setup.css",
  "settings/settings.html",
  "settings/settings.css",
];

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  for (const file of staticFiles) await cp(join(src, file), join(dist, file.split("/").pop()));
  await cp(join(src, "icons"), join(dist, "icons"), { recursive: true });

  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(src, "manifest.json"), "utf8"));
  manifest.version = version;
  await writeFile(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

const options = {
  absWorkingDir: root,
  entryPoints,
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome116",
  sourcemap: watching,
  minify: false, // readable output makes debugging an unpacked extension easier
  logLevel: "info",
};

await rm(dist, { recursive: true, force: true });
await copyStatic();

if (watching) {
  const ctx = await context(options);
  await ctx.watch();
  watchFiles(src, { recursive: true }, (_event, file) => {
    if (file && !file.endsWith(".ts")) copyStatic().catch((e) => console.error(e));
  });
  console.log("watching src/ — reload the extension in the browser after changes");
} else {
  await build(options);
}
