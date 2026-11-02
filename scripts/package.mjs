// Zips dist/ into release/dohra-extension.zip, the file attached to GitHub releases.
// The name carries no version, so .../releases/latest/download/dohra-extension.zip
// always fetches the newest; the release itself is named after the version.
// Run after a build. Uses the system `zip` (present on Linux, macOS and CI runners).

import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release", "dohra-extension.zip");

await mkdir(dirname(out), { recursive: true });
await rm(out, { force: true });
execFileSync("zip", ["-qr", out, "."], { cwd: join(root, "dist"), stdio: "inherit" });
console.log("release/dohra-extension.zip");
