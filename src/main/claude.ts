// The chat, answered by the local `claude` CLI.
//
// No API key anywhere: the CLI is already logged in with the user's Claude
// subscription, so each turn is one `claude -p` run and the conversation is
// carried from turn to turn with `--resume`. Output is read as stream-json, so
// the island can write the reply as it arrives and show which tool is running.
//
// What the chat may do is decided here, not by the model:
//   * read-only tools (Read, Glob, Grep, web search/fetch) are always allowed;
//   * in "ask" mode every other tool goes through poupou-hook as a PreToolUse
//     gate, which puts an Allow / Deny card on the island and waits;
//   * in "readonly" mode those tools are simply not available.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { hookCommand } from "./hooks";
import { emit } from "./island";
import { dataDir, log, type Settings } from "./store";

const SYSTEM_PROMPT = `You are Poupou, a small assistant living in a notch-sized panel at the top of the user's Windows screen. Replies are shown in a narrow chat bubble that renders plain text only.

Be direct and brief: answer first, a few short lines at most unless the task truly needs more. Reply in the user's language. No markdown at all — no **, no #, no backticks, no tables, no bullet dashes. Use plain sentences and line breaks.

You can read files, search the web and, when the user asks for it, run commands or edit files; those actions may need the user's approval, which they give from the panel. If something is denied, say so in one line and carry on.`;

const READ_ONLY_TOOLS = "Read,Glob,Grep,WebSearch,WebFetch,TodoWrite";
const CHANGING_TOOLS = "Bash,PowerShell,Write,Edit,MultiEdit,NotebookEdit";

export type ChatContext = { kind: "file"; name: string; path: string };

export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  loggedIn: boolean;
  plan: string | null;
  email: string | null;
}

let sessionId: string | null = null;
let running: ChildProcess | null = null;
let stopped = false;

// ── Finding and launching the CLI ─────────────────────────────────────────────

/** Our own `where`: walks %PATH%, then the places the installers use. */
export function findClaude(): string | null {
  const names = ["claude.exe", "claude.cmd"];
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(homedir(), ".local", "bin"),
    join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm"),
  ];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The environment the CLI runs in. Two things are removed on purpose:
 *   * API keys — with one set the CLI bills the API instead of the subscription;
 *   * the markers of a surrounding Claude Code session, when Poupou itself was
 *     started from one, so the chat is a session of its own.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "CLAUDE_EFFORT") delete env[key];
    else if (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_OAUTH_TOKEN") delete env[key];
    else if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN") delete env[key];
  }
  return { ...env, ...extra };
}

/** `.cmd` shims need cmd.exe; a real exe is spawned directly, no shell involved. */
function launch(claude: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) {
  if (/\.(cmd|bat)$/i.test(claude)) {
    const quote = (s: string) => (s === "" || /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return spawn([claude, ...args].map(quote).join(" "), { ...options, shell: true, windowsHide: true });
  }
  return spawn(claude, args, { ...options, windowsHide: true });
}

function run(claude: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = launch(claude, args, { env: childEnv() });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin?.end();
  });
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  const path = findClaude();
  const status: ClaudeStatus = { found: path != null, path, version: null, loggedIn: false, plan: null, email: null };
  if (!path) return status;
  try {
    status.version = (await run(path, ["--version"], 15_000)).trim().split(/\s+/)[0] || null;
  } catch {
    // the version is decoration; carry on
  }
  try {
    const auth = JSON.parse(await run(path, ["auth", "status"], 20_000)) as Record<string, unknown>;
    status.loggedIn = auth.loggedIn === true;
    status.email = typeof auth.email === "string" ? auth.email : null;
    const plan = typeof auth.subscriptionType === "string" ? auth.subscriptionType : null;
    status.plan = plan ? `Claude ${plan.charAt(0).toUpperCase()}${plan.slice(1)}` : null;
  } catch (err) {
    log(`claude auth status failed: ${String(err)}`);
  }
  return status;
}

// ── One chat turn ─────────────────────────────────────────────────────────────

function lastPathComponent(p: string): string {
  return basename(p.replace(/[\\/]+$/, "")) || p;
}

/** "Reads · notes.md" — what the typing dots say while a tool runs. */
function stepLabel(tool: string, input: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    Bash: "Runs", PowerShell: "Runs", Read: "Reads", Write: "Writes", Edit: "Edits", MultiEdit: "Edits",
    Glob: "Finds", Grep: "Searches", WebSearch: "Searches the web", WebFetch: "Fetches", TodoWrite: "Plans",
  };
  const label = labels[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const detail =
    str("command") ?? (str("file_path") ? lastPathComponent(str("file_path")!) : null) ??
    (str("path") ? lastPathComponent(str("path")!) : null) ?? str("query") ?? str("pattern") ?? str("url");
  return detail ? `${label} · ${detail.slice(0, 48)}` : label;
}

/** Writes the files `claude` is pointed at and returns the argument list. */
function buildArgs(settings: Settings): string[] {
  const dir = join(dataDir(), "chat");
  mkdirSync(dir, { recursive: true });

  const promptFile = join(dir, "system-prompt.txt");
  writeFileSync(promptFile, SYSTEM_PROMPT);

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // The chat is not one of the user's coding sessions: their plugins, hooks
    // and project settings stay out of it. Login is unaffected.
    "--setting-sources", "",
    "--append-system-prompt-file", promptFile,
    "--allowedTools", READ_ONLY_TOOLS,
  ];

  if (settings.chatAccess === "ask") {
    const gate = join(dir, "settings.json");
    writeFileSync(
      gate,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: hookCommand("ChatGate"), timeout: 120 }] },
          ],
        },
      }, null, 2),
    );
    args.push("--settings", gate);
  } else {
    args.push("--disallowedTools", CHANGING_TOOLS);
  }

  if (settings.model) args.push("--model", settings.model);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

function workingDir(settings: Settings): string {
  const wanted = settings.chatCwd.trim();
  try {
    if (wanted && statSync(wanted).isDirectory()) return wanted;
  } catch {
    // fall through to the home directory
  }
  return homedir();
}

export function chatSend(
  settings: Settings,
  query: string,
  context: ChatContext | null,
): Promise<{ text: string }> {
  const claude = findClaude();
  if (!claude) {
    return Promise.reject(new Error("Claude Code CLI not found. Install it, run `claude` once to sign in, then try again."));
  }
  if (running) return Promise.reject(new Error("Still answering the previous message."));

  // A dropped file rides along with the first message; the Read tool does the rest.
  const prompt = context ? `[Attached file: ${context.path}]\n\n${query}` : query;

  return new Promise((resolve, reject) => {
    const child = launch(claude, buildArgs(settings), {
      cwd: workingDir(settings),
      env: childEnv({ POUPOU_CHAT: "1" }),
    });
    running = child;
    stopped = false;
    const startedAt = Date.now();
    log(`chat turn started (${settings.chatAccess}${sessionId ? ", resumed" : ""})`);

    let buffer = "";
    let stderr = "";
    let sawText = false;
    let result: { text: string; isError: boolean } | null = null;

    const onLine = (line: string) => {
      if (!line.trim()) return;
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg.session_id === "string" && msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
      }
      if (msg.type === "stream_event") {
        const event = msg.event ?? {};
        // Sub-agents talk among themselves; only the main thread reaches the bubble.
        if (msg.parent_tool_use_id) return;
        if (event.type === "message_start" && sawText) emit("chat-delta", { text: "\n\n" });
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          sawText = true;
          emit("chat-delta", { text: event.delta.text });
        }
      } else if (msg.type === "assistant" && !msg.parent_tool_use_id) {
        for (const block of msg.message?.content ?? []) {
          if (block?.type === "tool_use") {
            emit("chat-delta", { step: stepLabel(String(block.name ?? "Tool"), block.input ?? {}) });
          }
        }
      } else if (msg.type === "result") {
        if (typeof msg.session_id === "string") sessionId = msg.session_id;
        result = {
          text: typeof msg.result === "string" ? msg.result.trim() : "",
          isError: msg.is_error === true,
        };
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (err) => {
      running = null;
      reject(new Error(`Could not start claude: ${err.message}`));
    });
    child.on("close", (code) => {
      running = null;
      if (buffer) onLine(buffer);
      if (stopped) return reject(new Error("Stopped."));
      if (result && !result.isError && result.text) {
        log(`chat turn done in ${Date.now() - startedAt} ms`);
        return resolve({ text: result.text });
      }
      const why = result?.text || stderr.trim().split("\n").pop() || `claude exited with code ${code}`;
      log(`chat failed: ${why}`);
      // A session the CLI no longer has must not poison every later turn.
      if (/no conversation found|session.*not found/i.test(why)) sessionId = null;
      reject(new Error(why));
    });

    child.stdin?.end(prompt);
  });
}

export function chatStop() {
  if (!running) return;
  stopped = true;
  // /T takes the hook relay and any tool the turn started down with it.
  if (running.pid) execFile("taskkill", ["/pid", String(running.pid), "/T", "/F"], () => {});
  else running.kill();
}

export function chatReset() {
  chatStop();
  sessionId = null;
}
