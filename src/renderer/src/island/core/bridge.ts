// Thin wrapper over the Electron IPC exposed by the preload script. Every call
// is a no-op when the page is opened in a plain browser, so the island can be
// iterated on with a bare Vite server.

import type { Settings } from "./state";

interface NativeApi {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  on(name: string, handler: (payload: unknown) => void): () => void;
  pathForFile(file: File): string;
}

const native = (window as unknown as { poupou?: NativeApi }).poupou;

export const IS_NATIVE = native != null;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!native) return null;
  try {
    return await native.invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[poupou] ${cmd} failed`, err);
    return null;
  }
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!native) throw new Error("not running inside Poupou");
  try {
    return await native.invoke<T>(cmd, args);
  } catch (err) {
    // Electron prefixes rejected handlers with "Error invoking remote method …:".
    const text = String(err instanceof Error ? err.message : err);
    throw new Error(text.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
}

export interface BootInfo {
  settings: Settings;
  version: string;
  hookPath: string;
  /** False under `npm run dev`, where the app cannot register itself to start at login. */
  packaged: boolean;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. The main process flips
   * click-through from its own cursor poll, so the flag is never a frame behind.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Appends to poupou.log, next to the main-process lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat and files ────────────────────────────────────────────────────────
  /**
   * One chat turn, answered by the local `claude` CLI on the logged-in
   * subscription. Text arrives through `chat-delta` events while it runs.
   */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatStop: () => call<void>("chat_stop"),
  chatReset: () => call<void>("chat_reset"),
  /** Is the `claude` CLI there, and is it logged in? */
  claudeStatus: () => call<ClaudeStatus>("claude_status"),
  /** Can the chat answer with the current sign-in method? */
  chatReady: () => call<{ ready: boolean; mode: "subscription" | "apikey" }>("chat_ready"),
  apiKeyStatus: () => call<ApiKeyStatus>("api_key_status"),
  /** Checks the key with Anthropic, then stores it encrypted. Never read back. */
  apiKeySet: (key: string) => callOrThrow<ApiKeyStatus>("api_key_set", { key }),
  apiKeyClear: () => call<ApiKeyStatus>("api_key_clear"),
  /** Checks a dropped file and reports its name back. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  pickFolder: () => call<string | null>("pick_folder"),
  /** Asks the OS for the microphone where that is a thing (macOS). */
  micAccess: () => call<boolean>("mic_access"),

  /** Tray → Pause. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),
};

export type ChatContext = { kind: "file"; name: string; path: string };

export interface ChatDelta {
  /** Text to append to the reply being written. */
  text?: string;
  /** A tool the chat just started, e.g. "Read · notes.md". */
  step?: string;
}

export interface ApiKeyStatus {
  present: boolean;
  /** Last four characters, e.g. "…a1B2". */
  hint: string | null;
  /** Which way an API-key chat runs: through Claude Code ("cli") or straight to the API. */
  engine?: "cli" | "api";
}

export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  /** "Claude Max", "Claude Pro"… when the CLI reports it. */
  plan: string | null;
  email: string | null;
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/**
 * Files dragged onto the island. Chromium only delivers these while the window
 * takes the mouse, which is the island shape itself (and the wake strip).
 */
export function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!native) return () => {};
  // Tracked as one flag, not a dragenter/dragleave count: the island rebuilds
  // its DOM mid-drag, and an element removed under the cursor never sends its
  // dragleave, which would leave a count stuck above zero.
  let inside = false;
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!inside) {
      inside = true;
      handler({ type: "enter" });
    }
  };
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    // Only a leave with nowhere to go is the drag leaving the window.
    if (e.relatedTarget != null || !inside) return;
    inside = false;
    handler({ type: "leave" });
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    inside = false;
    const paths = Array.from(e.dataTransfer?.files ?? [])
      .map((f) => native.pathForFile(f))
      .filter(Boolean);
    handler({ type: "drop", paths });
  };

  document.addEventListener("dragenter", enter);
  document.addEventListener("dragover", over);
  document.addEventListener("dragleave", leave);
  document.addEventListener("drop", drop);
  return () => {
    document.removeEventListener("dragenter", enter);
    document.removeEventListener("dragover", over);
    document.removeEventListener("dragleave", leave);
    document.removeEventListener("drop", drop);
  };
}

export function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!native) return () => {};
  return native.on(name, (payload) => handler(payload as T));
}
