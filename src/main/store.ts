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
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  screen: "primary",
  hooksInstalled: false,
  model: "",
  chatCwd: "",
  chatAccess: "ask",
};

export const dataDir = () => app.getPath("userData");

/** The relay Claude Code runs. Copied here at launch so the path never moves. */
export const hookScriptPath = () => join(dataDir(), "bin", "poupou-hook.cjs");

const settingsFile = () => join(dataDir(), "settings.json");
const logFile = () => join(dataDir(), "poupou.log");

export function loadSettings(): Settings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile(), "utf8"));
    if (parsed && typeof parsed === "object") return { ...DEFAULT_SETTINGS, ...(parsed as Partial<Settings>) };
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
