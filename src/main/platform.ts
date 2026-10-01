// The few places where Windows and macOS (and Linux) differ.

import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

/**
 * Where command-line tools live besides %PATH%. An app started from the Dock or
 * the Start menu does not get the PATH a terminal has — on macOS it gets almost
 * nothing — so `claude` and `node` have to be looked for by hand.
 */
function extraBinDirs(): string[] {
  const home = homedir();
  if (IS_WIN) {
    return [
      join(home, ".local", "bin"),
      join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
      join(process.env.ProgramFiles ?? "C:\\Program Files", "nodejs"),
    ];
  }
  return [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    "/usr/bin",
  ];
}

/** %PATH% first, then the usual install locations. */
export function searchDirs(): string[] {
  return [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), ...extraBinDirs()];
}

/** Our own `where` / `which`: the first of `names` found in the search dirs. */
export function findProgram(names: string[]): string | null {
  for (const dir of searchDirs()) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export const findNode = () => findProgram(IS_WIN ? ["node.exe"] : ["node"]);

/** A PATH that also holds the usual install locations, for the processes we start. */
export function widenedPath(): string {
  return [...new Set(searchDirs())].join(delimiter);
}

/**
 * Where the hook relay reaches the app: a named pipe on Windows, a socket file
 * in the home folder elsewhere. Must match `pipePath()` in
 * resources/poupou-hook.cjs exactly.
 */
export function relayPath(): string {
  if (IS_WIN) {
    const user = (process.env.USERNAME || userInfo().username || "user").replace(/[^A-Za-z0-9_.-]/g, "_");
    return `\\\\.\\pipe\\poupou-${user}`;
  }
  return join(homedir(), ".poupou.sock");
}
