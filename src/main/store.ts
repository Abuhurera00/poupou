// Where things live on disk, the settings file, and the log.

import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type ChatAccess = "ask" | "readonly";

/** Kept in step with `Settings` in src/renderer/src/island/core/state.ts. */
export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  screen: "primary" | "cursor";
  hooksInstalled: boolean;
  model: string;
  chatCwd: string;
  chatAccess: ChatAccess;
  /** Start with the computer (built app only). */
  autostart: boolean;
  /** Speech model size: bigger hears better and downloads more. */
  voiceModel: "tiny" | "base" | "small";
  /** Spoken language as a Whisper code ("en", "ur"…); empty = detect it. */
  voiceLanguage: string;
  /** Send the message as soon as it is transcribed, instead of waiting for Enter. */
  voiceAutoSend: boolean;
  /** Bumped when a default changes in a way old settings files should pick up. */
  settingsVersion: number;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  screen: "cursor",
  hooksInstalled: false,
  model: "",
  chatCwd: "",
  chatAccess: "ask",
  autostart: false,
  voiceModel: "base",
  voiceLanguage: "",
  voiceAutoSend: false,
  settingsVersion: 2,
};

export const dataDir = () => app.getPath("userData");

/** The relay Claude Code runs. Copied here at launch so the path never moves. */
export const hookScriptPath = () => join(dataDir(), "bin", "poupou-hook.cjs");

const settingsFile = () => join(dataDir(), "settings.json");
const logFile = () => join(dataDir(), "poupou.log");

export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(), "utf8"));
    if (parsed && typeof parsed === "object") {
      const saved = parsed as Partial<Settings>;
      // Before version 2 "primary" was the default nobody picked; with a
      // second monitor it hid the island from it. Follow the pointer instead.
      if ((saved.settingsVersion ?? 1) < 2 && saved.screen === "primary") saved.screen = "cursor";
      return { ...DEFAULT_SETTINGS, ...saved, settingsVersion: DEFAULT_SETTINGS.settingsVersion };
    }
  } catch {
    // first launch, or a file we cannot read: defaults are fine
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Settings) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    log(`could not save settings: ${String(err)}`);
  }
}

const MAX_LOG_BYTES = 1 << 20;

/** Hook events, permission decisions, chat problems. Stays on this machine. */
export function log(message: string) {
  try {
    const file = logFile();
    mkdirSync(dataDir(), { recursive: true });
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.old`);
    appendFileSync(file, `${new Date().toISOString()}  ${message}\n`);
  } catch {
    // a log line must never take the app down
  }
}
