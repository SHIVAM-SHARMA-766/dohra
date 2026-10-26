// The speech-model list shown on the setup page and in Settings: download a
// model, watch it arrive, switch between installed ones, remove the rest.
// Models are managed only here; the companion's command line does not offer it.

import type { ModelAction, Reply } from "./messages";
import { formatBytes } from "./session";
import { COMPANION_KEY, type CompanionInfo, type ModelInfo } from "./transcript";

/** How each model behaves, measured on a 6-core/12-thread laptop CPU (Ryzen 5 7430U). */
export const MODEL_TEXT: Record<string, string> = {
  small: "Fastest. Keeps up with the class on almost any laptop, but makes more mistakes, especially in Hindi.",
  medium:
    "Balanced. Keeps up during class on a 6-core laptop; on slower ones the transcript finishes a little after the class.",
  large:
    "Best for Hindi and Hinglish: Whisper trained on 700 hours of Indian Hindi (Oriserve Hindi2Hinglish). Slower: on a 6-core laptop the transcript finishes about 15 minutes after an hour-long class.",
};

/** The model to suggest for a computer with this many logical CPUs. */
export function recommendedModel(cpus: number): string {
  return cpus >= 8 ? "medium" : "small";
}

export async function modelRequest(action: ModelAction, model: string): Promise<CompanionInfo> {
  const reply = (await chrome.runtime.sendMessage({ target: "background", type: "model", action, model })) as
    | Reply
    | undefined;
  if (!reply) throw new Error("Dohra's background did not answer; reload the extension.");
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as CompanionInfo;
}

function button(text: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = text;
  if (className) b.className = className;
  b.addEventListener("click", onClick);
  return b;
}

function badge(text: string, kind = ""): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = `badge ${kind}`.trim();
  s.textContent = text;
  return s;
}

/**
 * Renders the models into a container, and re-renders as downloads progress.
 * Returns a function that stops listening.
 */
export function mountModelPicker(container: HTMLElement, initial: CompanionInfo, onChange?: (info: CompanionInfo) => void): () => void {
  let info = initial;
  let error: string | null = null;

  async function act(action: ModelAction, model: string): Promise<void> {
    error = null;
    for (const b of container.querySelectorAll("button")) b.disabled = true;
    try {
      info = await modelRequest(action, model);
      onChange?.(info);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    render();
  }

  function card(m: ModelInfo, recommended: string, anyInstalled: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "model";
    el.dataset.model = m.name;
    el.dataset.state = m.active ? "active" : m.installed ? "installed" : m.downloading ? "downloading" : "absent";

    const head = document.createElement("div");
    head.className = "model-head";
    const name = document.createElement("strong");
    name.textContent = m.label;
    head.append(name);
    if (m.name === recommended) head.append(badge("Recommended for this computer", "accent"));
    if (m.active) head.append(badge("In use", "ok"));
    else if (m.installed) head.append(badge("Installed"));

    const text = document.createElement("p");
    text.className = "hint";
    text.textContent = MODEL_TEXT[m.name] ?? "";

    const meta = document.createElement("p");
    meta.className = "model-meta";
    meta.textContent = m.downloading
      ? `Downloading… ${formatBytes(m.done)} of ${formatBytes(m.size)} (${Math.floor((100 * m.done) / Math.max(m.size, 1))}%)`
      : `${formatBytes(m.size)}${m.installed ? " on disk" : " download"}`;

    el.append(head, text, meta);

    if (m.downloading) {
      const bar = document.createElement("progress");
      bar.max = m.size;
      bar.value = m.done;
      el.append(bar);
    }
    if (m.error && !m.downloading) {
      const p = document.createElement("p");
      p.className = "banner warn";
      p.textContent = `Download did not finish: ${m.error}. Downloading again continues where it stopped.`;
      el.append(p);
    }

    const actions = document.createElement("div");
    actions.className = "model-actions";
    if (m.downloading) {
      actions.append(button("Cancel", () => void act("cancel", m.name)));
    } else if (!m.installed) {
      const primary = !anyInstalled && m.name === recommended;
      actions.append(button(m.error ? "Download again" : "Download", () => void act("install", m.name), primary ? "primary" : ""));
    } else if (!m.active) {
      actions.append(
        button("Use this model", () => void act("use", m.name), "primary"),
        button("Remove", () => {
          if (confirm(`Remove the ${m.label} model? It frees ${formatBytes(m.size)}; you can download it again later.`)) {
            void act("remove", m.name);
          }
        }),
      );
    }
    if (actions.childElementCount > 0) el.append(actions);
    return el;
  }

  function render(): void {
    container.replaceChildren();
    if (error) {
      const p = document.createElement("p");
      p.className = "banner error";
      p.textContent = error;
      container.append(p);
    }
    const recommended = recommendedModel(info.cpus);
    const anyInstalled = info.models.some((m) => m.installed);
    for (const m of info.models) container.append(card(m, recommended, anyInstalled));
  }

  const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
    const next = changes[COMPANION_KEY]?.newValue as CompanionInfo | undefined;
    if (!next || !next.installed) return;
    info = next;
    onChange?.(info);
    render();
  };
  chrome.storage.session.onChanged.addListener(listener);
  render();
  return () => chrome.storage.session.onChanged.removeListener(listener);
}
