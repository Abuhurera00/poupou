// Claude Code hook installation.
//
// The rule is strict: read %USERPROFILE%\.claude\settings.json, take a dated
// backup, merge without touching anybody else's hooks, show the diff, and write
// only after an explicit click. Uninstall removes Poupou's entries and nothing
// else.
//
// The command is `node` plus the quoted script path in forward slashes and the
// event name: on Windows Claude Code runs hook commands through Git Bash, and
// anything with backslashes, PowerShell or cmd syntax in it breaks.

import { app } from "electron";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { hookScriptPath, log } from "./store";

/**
 * Every event the island reacts to, with the hook timeout written to
 * settings.json. PermissionRequest waits for a human, so it gets the decision
 * timeout + 10 s.
 */
const HOOK_EVENTS: [string, number][] = [
  ["SessionStart", 10],
  ["SessionEnd", 10],
  ["UserPromptSubmit", 10],
  ["PreToolUse", 10],
  ["PostToolUse", 10],
  ["PostToolUseFailure", 10],
  ["PermissionRequest", 120],
  ["Notification", 10],
  ["Stop", 10],
  ["StopFailure", 10],
  ["SubagentStart", 10],
  ["SubagentStop", 10],
];

/** Marker that identifies a Poupou entry inside settings.json. */
const MARKER = "poupou-hook";

type Json = Record<string, unknown>;

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
  /** Identifies the bytes this diff was computed from. */
  fingerprint: string;
}

export const claudeSettingsPath = () => join(homedir(), ".claude", "settings.json");

/** The hook command for one event, as it is written into settings.json. */
export function hookCommand(event: string): string {
  return `node "${hookScriptPath().replace(/\\/g, "/")}" ${event}`;
}

const isObject = (v: unknown): v is Json => v != null && typeof v === "object" && !Array.isArray(v);

/**
 * Reads `~/.claude/settings.json`.
 *
 * The only error that means "start from nothing" is the file not being there.
 * Everything else — a lock, a permission problem, JSON we cannot parse — is
 * reported, because the alternative is treating somebody's unreadable settings
 * as an empty object and then writing that back over them.
 */
function readSettings(): Json {
  const path = claudeSettingsPath();
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Can't read ${path}: ${String(err)}`);
  }
  return parseSettings(bytes, path);
}

export function parseSettings(bytes: Buffer, path: string): Json {
  // PowerShell writes a UTF-8 BOM with `Set-Content -Encoding utf8`.
  const text = (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes).toString("utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} isn't valid JSON (${String(err)}). Fix or move it, then try again — Poupou won't overwrite it.`,
    );
  }
  if (!isObject(parsed)) throw new Error(`${path} isn't a JSON object — Poupou won't touch it.`);
  return parsed;
}

function entryIsOurs(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => isObject(h) && typeof h.command === "string" && h.command.includes(MARKER),
  );
}

/** Settings with Poupou's hooks added; everything else is left untouched. */
export function merged(existing: Json): Json {
  const root: Json = { ...existing };
  const hooks: Json = isObject(root.hooks) ? { ...root.hooks } : {};
  for (const [event, timeout] of HOOK_EVENTS) {
    const list = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).filter((e) => !entryIsOurs(e)) : [];
    list.push({ hooks: [{ type: "command", command: hookCommand(event), timeout }] });
    hooks[event] = list;
  }
  root.hooks = hooks;
  return root;
}

/** Settings with every Poupou entry removed, and nothing else changed. */
export function withoutOurs(existing: Json): Json {
  const root: Json = { ...existing };
  if (!isObject(root.hooks)) return root;
  const out: Json = {};
  for (const [event, value] of Object.entries(root.hooks)) {
    if (!Array.isArray(value)) {
      out[event] = value;
      continue;
    }
    const kept = value.filter((e) => !entryIsOurs(e));
    if (kept.length > 0) out[event] = kept;
  }
  if (Object.keys(out).length === 0) delete root.hooks;
  else root.hooks = out;
  return root;
}

const pretty = (v: Json) => JSON.stringify(v, null, 2);

/** Down to the second: install then uninstall in the same minute keeps both backups. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const backupPath = () => join(dirname(claudeSettingsPath()), `settings.json.bak-${stamp()}`);

/** FNV-1a is plenty: the question is only "is this still the file I showed?". */
export function fingerprint(bytes: Buffer): string {
  let hash = 0xcbf29ce484222325n;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function currentFingerprint(): string {
  try {
    return fingerprint(readFileSync(claudeSettingsPath()));
  } catch {
    return fingerprint(Buffer.alloc(0));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function hooksStatus(): HookStatus {
  let installed = false;
  try {
    const hooks = readSettings().hooks;
    if (isObject(hooks)) {
      installed = Object.values(hooks).some((list) => Array.isArray(list) && list.some(entryIsOurs));
    }
  } catch {
    // status must never fail loudly; anything that writes surfaces the error
  }
  return {
    installed,
    settingsPath: claudeSettingsPath(),
    hookPath: hookScriptPath(),
    hookReady: existsSync(hookScriptPath()),
  };
}

export function hooksPreview(install: boolean): HookPreview {
  const current = readSettings();
  const next = install ? merged(current) : withoutOurs(current);
  return {
    diff: unifiedDiff(pretty(current), pretty(next)),
    backup: backupPath(),
    settingsPath: claudeSettingsPath(),
    fingerprint: currentFingerprint(),
  };
}

/**
 * Writes the merged (or cleaned) settings after taking a dated backup.
 *
 * `expected` is the fingerprint the preview was computed from. If the file
 * changed in between we stop and make the user look at a fresh diff, because
 * the only thing worse than not installing the hooks is silently reverting
 * somebody else's edit.
 */
export function hooksApply(install: boolean, expected: string): string {
  const path = claudeSettingsPath();
  mkdirSync(dirname(path), { recursive: true });

  // Read before the backup: an unreadable file must abort before we touch anything.
  const current = readSettings();
  if (currentFingerprint() !== expected) {
    throw new Error(`${path} changed since the preview. Nothing was written — review the new diff.`);
  }

  const backup = backupPath();
  if (existsSync(path)) copyFileSync(path, backup);

  const next = install ? merged(current) : withoutOurs(current);

  // Write beside the target and rename over it: a crash or a full disk leaves
  // the original settings.json intact rather than half a file.
  const temp = `${path}.poupou-${process.pid}`;
  try {
    writeFileSync(temp, `${pretty(next)}\n`);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw new Error(`write failed: ${String(err)}`);
  }
  log(`hooks ${install ? "installed" : "removed"}; backup at ${backup}`);
  return backup;
}

/** Copies the relay script into the data folder on launch. */
export function ensureHookScript() {
  const source = app.isPackaged
    ? join(process.resourcesPath, "poupou-hook.cjs")
    : join(app.getAppPath(), "resources", "poupou-hook.cjs");
  const dest = hookScriptPath();
  try {
    mkdirSync(dirname(dest), { recursive: true });
    const fresh = readFileSync(source);
    if (existsSync(dest) && readFileSync(dest).equals(fresh)) return;
    writeFileSync(dest, fresh);
  } catch (err) {
    log(`could not install poupou-hook.cjs from ${source}: ${String(err)}`);
  }
}

// ── Minimal unified diff (LCS) ────────────────────────────────────────────────

/** settings.json is short, so a plain O(n·m) LCS is the simplest honest diff. */
export function unifiedDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);

  // Keep three lines of context around each change so the panel stays readable.
  const keep = new Array<boolean>(out.length).fill(false);
  let changed = false;
  out.forEach((line, idx) => {
    if (!line.startsWith("+") && !line.startsWith("-")) return;
    changed = true;
    for (let k = Math.max(0, idx - 3); k < Math.min(out.length, idx + 4); k++) keep[k] = true;
  });
  if (!changed) return "No change.";

  const lines: string[] = [];
  let gap = false;
  out.forEach((line, idx) => {
    if (keep[idx]) {
      lines.push(line);
      gap = false;
    } else if (!gap) {
      lines.push("  …");
      gap = true;
    }
  });
  return `${lines.join("\n")}\n`;
}
