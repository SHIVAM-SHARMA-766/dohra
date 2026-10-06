// The offscreen recorder cannot show a permission prompt, so microphone access is
// granted here, on a visible extension page. The grant applies to the whole extension.

export {}; // a module, so these names do not collide with window globals

const button = document.getElementById("allow") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLParagraphElement;

function show(state: "granted" | "denied" | "prompt", text: string): void {
  status.dataset.state = state;
  status.textContent = text;
  button.hidden = state === "granted";
}

async function check(): Promise<void> {
  const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
  if (result.state === "granted") show("granted", "Microphone allowed. You can close this tab.");
  else if (result.state === "denied")
    show("denied", "Microphone is blocked. Allow it in the browser's site settings for this extension, then reload.");
  else show("prompt", "");
}

button.addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Reported by check() below.
  }
  await check();
});

void check();
