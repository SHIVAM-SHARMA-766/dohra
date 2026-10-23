// Setup page for the transcription companion: install commands for each OS, the
// one for this computer first, and a live check of whether it is ready.

import type { CompanionInfo } from "../lib/transcript";
import type { Reply } from "../lib/messages";

const REPO = "SHIVAM-SHARMA-766/dohra";

interface Platform {
  id: string;
  name: string;
  commands: string;
}

const PLATFORMS: Platform[] = [
  {
    id: "linux",
    name: "Linux (x86-64)",
    commands: `gh release download --repo ${REPO} --pattern dohra-companion-linux-amd64 --output dohra-companion
chmod +x dohra-companion
./dohra-companion install`,
  },
  {
    id: "windows",
    name: "Windows (PowerShell)",
    commands: `gh release download --repo ${REPO} --pattern dohra-companion-windows-amd64.exe --output dohra-companion.exe
.\\dohra-companion.exe install`,
  },
  {
    id: "mac",
    name: "macOS",
    commands: `brew install whisper-cpp
gh release download --repo ${REPO} --pattern "dohra-companion-darwin-$(uname -m | sed s/x86_64/amd64/)" --output dohra-companion
chmod +x dohra-companion
./dohra-companion install`,
  },
];

function currentPlatform(): string {
  const p = navigator.platform.toLowerCase();
  if (p.startsWith("win")) return "windows";
  if (p.startsWith("mac")) return "mac";
  return "linux";
}

function renderPlatforms(): void {
  const here = currentPlatform();
  const sorted = [...PLATFORMS].sort((a, b) => Number(b.id === here) - Number(a.id === here));
  const container = document.getElementById("platforms")!;
  for (const p of sorted) {
    const section = document.createElement("div");
    section.className = `platform${p.id === here ? " current" : ""}`;
    const title = document.createElement("h3");
    title.textContent = p.name;
    const pre = document.createElement("pre");
    pre.textContent = p.commands;
    section.append(title, pre);
    container.append(section);
  }
}

async function check(): Promise<void> {
  const status = document.getElementById("status")!;
  status.textContent = "Checking…";
  delete status.dataset.ready;
  try {
    const reply = (await chrome.runtime.sendMessage({ target: "background", type: "companion-status" })) as Reply;
    if (!reply.ok) throw new Error(reply.error);
    const info = reply.data as CompanionInfo;
    status.dataset.ready = String(info.ready);
    status.textContent = info.ready
      ? `Ready — companion ${info.version}, ${info.model} model.`
      : info.problems.join(" ") || "Not ready.";
  } catch (e) {
    status.textContent = `Could not check: ${e instanceof Error ? e.message : String(e)}`;
  }
}

renderPlatforms();
document.getElementById("check")!.addEventListener("click", () => void check());
void check();
