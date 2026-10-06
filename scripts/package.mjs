// Zips dist/ into release/dohra-<version>.zip, the file attached to GitHub releases.
// Run after a build. Uses the system `zip` (present on Linux, macOS and CI runners).

import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const out = join(root, "release", `dohra-${version}.zip`);

await mkdir(dirname(out), { recursive: true });
await rm(out, { force: true });
execFileSync("zip", ["-qr", out, "."], { cwd: join(root, "dist"), stdio: "inherit" });
console.log(`release/dohra-${version}.zip`);
