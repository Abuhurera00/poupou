// Poupou — app wiring and the commands the pages call.

import { BrowserWindow, app, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { chatReset, chatSend, chatStop, claudeStatus, type ChatContext } from "./claude";
import { ensureHookScript, hooksApply, hooksPreview, hooksStatus } from "./hooks";
import {
  createIslandWindow, emit, focusIsland, islandWindow, reposition, setCollapsed, setIslandRect,
  setScreenPref,
} from "./island";
import { acknowledge, answer, decline, startPipe, stopPipe } from "./pipe";
import { hookScriptPath, loadSettings, log, saveSettings, type Settings } from "./store";
import { buildTray, drawIcon } from "./tray";

let settings: Settings;
let settingsWindow: BrowserWindow | null = null;

/** Dev builds are served by Vite; a built app loads the files next to it. */
function loadPage(win: BrowserWindow, page: string) {
  // Our pages never go anywhere else — not for a link, not for a dropped file.
  // A reload of the page itself (Vite does that in dev) is still allowed.
  win.webContents.on("will-navigate", (event, url) => {
    const here = win.webContents.getURL().split(/[?#]/)[0];
    if (url.split(/[?#]/)[0] !== here) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) void win.loadURL(`${devUrl}/${page}`);
  else void win.loadFile(join(__dirname, "../renderer", page));
}

function broadcast(name: string, payload: unknown) {
  emit(name, payload);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("poupou:event", name, payload);
  }
}

function showSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 480,
    minHeight: 520,
    show: false,
    title: "Poupou — Settings",
    backgroundColor: "#0b0c0e",
    autoHideMenuBar: true,
    icon: drawIcon(64),
    webPreferences: { preload: join(__dirname, "../preload/index.js") },
  });
  settingsWindow.setMenu(null);
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  settingsWindow.on("closed", () => (settingsWindow = null));
  loadPage(settingsWindow, "settings.html");
}

// ── Opening things ────────────────────────────────────────────────────────────

/**
 * Finds VS Code's own executable. `code` on PATH is a .cmd shim, and running
 * that means cmd.exe reading `&`, `^` and `%` in a folder name as syntax; the
 * exe takes the folder as a plain argument instead.
 */
function findVSCode(): string | null {
  const candidates: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "code.cmd"))) candidates.push(join(dir, "..", "Code.exe"));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"));
  }
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"));
  return candidates.find((c) => existsSync(c)) ?? null;
}

function openInVSCode(path: string | null): boolean {
  const code = findVSCode();
  if (code) {
    // VS Code is itself an Electron app: a leftover ELECTRON_RUN_AS_NODE from
    // our own environment would make it start as plain Node.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      spawn(code, path ? [path] : [], { detached: true, stdio: "ignore", env }).unref();
      return true;
    } catch (err) {
      log(`could not start VS Code: ${String(err)}`);
    }
  }
  if (path) void shell.openPath(path);
  return false;
}

// ── Commands ──────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const commands: Record<string, (args: Args) => unknown> = {
  boot: () => {
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    settings.hooksInstalled = hooksStatus().installed;
    return { settings, version: app.getVersion(), hookPath: hookScriptPath() };
  },

  save_settings: (a) => {
    const next = { ...settings, ...(a.settings as Partial<Settings>) };
    const workspaceChanged = next.chatCwd !== settings.chatCwd;
    settings = next;
    saveSettings(settings);
    setScreenPref(settings.screen);
    // A conversation belongs to the folder it started in.
    if (workspaceChanged) chatReset();
    broadcast("settings-changed", settings);
  },

  set_collapsed: (a) => setCollapsed(a.collapsed === true),
  set_island_rect: (a) => setIslandRect(Number(a.x), Number(a.y), Number(a.width), Number(a.height)),
  focus_window: (a) => focusIsland(a.focused === true),
  reposition: () => reposition(),

  open_url: (a) => {
    const url = str(a.url);
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  },
  open_in_vscode: (a) => openInVSCode(str(a.path) || null),
  open_settings_window: () => showSettingsWindow(),
  quit_app: () => app.quit(),
  log_line: (a) => log(`ui  ${str(a.message)}`),
  set_paused: () => {},

  // Claude Code hooks
  hooks_status: () => hooksStatus(),
  hooks_preview: (a) => hooksPreview(a.install === true),
  // Only ever called from an explicit click in the settings window.
  hooks_apply: (a) => {
    const backup = hooksApply(a.install === true, str(a.fingerprint));
    settings.hooksInstalled = a.install === true;
    saveSettings(settings);
    broadcast("settings-changed", settings);
    return backup;
  },
  approval_decision: (a) => answer(str(a.requestId), str(a.decision)),
  approval_ack: (a) => acknowledge(str(a.requestId)),
  approval_decline: (a) => decline(str(a.requestId)),

  // Chat and files
  chat_send: (a) => chatSend(settings, str(a.query), (a.context as ChatContext | null) ?? null),
  chat_stop: () => chatStop(),
  chat_reset: () => chatReset(),
  claude_status: () => claudeStatus(),
  ingest_file: (a) => {
    const path = str(a.path);
    let size: number;
    try {
      const meta = statSync(path);
      if (meta.isDirectory()) throw new Error("Folders can't be dropped yet.");
      size = meta.size;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Folders")) throw err;
      throw new Error(`Cannot read ${basename(path) || "that file"}.`);
    }
    // Nothing is copied: the chat reads the file where it already is.
    return { name: basename(path), path, size };
  },
  pick_folder: async () => {
    const options = {
      title: "Folder the chat works in",
      defaultPath: settings.chatCwd || app.getPath("home"),
      properties: ["openDirectory" as const],
    };
    const picked = settingsWindow
      ? await dialog.showOpenDialog(settingsWindow, options)
      : await dialog.showOpenDialog(options);
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  },
};

// ── Launch ────────────────────────────────────────────────────────────────────

// The island's sounds play without a click having unlocked audio first.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => emit("tray", "open"));

  void app.whenReady().then(() => {
    app.setAppUserModelId("dev.poupou.app");
    settings = loadSettings();
    log(`--- Poupou ${app.getVersion()} started ---`);

    ipcMain.handle("poupou:invoke", async (event, cmd: string, args: Args) => {
      // Only our own two pages may call in.
      const sender = BrowserWindow.fromWebContents(event.sender);
      if (sender !== islandWindow() && sender !== settingsWindow) throw new Error("unknown caller");
      const handler = commands[cmd];
      if (!handler) throw new Error(`unknown command: ${cmd}`);
      return handler(args ?? {});
    });

    ensureHookScript();
    startPipe();

    const island = createIslandWindow(settings.screen);
    loadPage(island, "index.html");

    buildTray({
      open: () => emit("tray", "open"),
      chat: () => emit("tray", "chat"),
      settings: showSettingsWindow,
      pause: () => emit("tray", "pause"),
    });
  });

  // The island has no close button and lives in the tray: closing the settings
  // window must not end the app.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    chatStop();
    stopPipe();
  });
}
