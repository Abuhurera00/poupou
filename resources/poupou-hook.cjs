#!/usr/bin/env node
// poupou-hook — the relay Claude Code runs on every hook event.
//
// Reads the hook JSON on stdin and hands it to Poupou over the named pipe
// `\\.\pipe\poupou-<user>`. Plain Node, no dependencies, so it starts fast and
// can be copied anywhere.
//
// Hard rule: never block Claude Code.
//   * If the pipe does not exist — Poupou is closed — exit 0 with nothing on
//     stdout, and the session carries on untouched.
//   * Every run has a deadline; when it passes we exit, whatever the pipe is doing.
//   * Only a permission request waits for an answer. No answer means empty
//     stdout, and Claude Code asks in the terminal as if Poupou were not installed.
//
// Usage: node poupou-hook.cjs <EventName>
//        node poupou-hook.cjs ChatGate      (PreToolUse inside Poupou's own chat)

"use strict";

const net = require("net");

/** Budget for getting a pipe connection. Beyond this Claude Code wins, always. */
const CONNECT_TIMEOUT = 300;
/** Whole-run budget for an event nobody waits on. */
const FIRE_AND_FORGET_BUDGET = 2000;
/** How long a permission prompt may stay on screen before we give up. */
const DECISION_BUDGET = 110000;

/** Pointless to forward and can be enormous (a whole file, a full command output). */
const DROPPED_FIELDS = ["tool_response", "transcript_path"];
const MAX_FIELD_LEN = 2000;

/** Tools the chat may use without asking: they only look, they never change. */
const CHAT_SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoWrite", "Task", "Agent",
  "NotebookRead", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool",
]);

const arg = process.argv[2] || "";
const inChat = process.env.POUPOU_CHAT === "1";
const chatGate = arg === "ChatGate";

// Hooks installed in the user's settings also fire inside Poupou's own chat
// process. Those are not a Claude Code session to show: stay out of the way.
if (inChat && !chatGate) process.exit(0);
if (chatGate && !inChat) process.exit(0);

function pipePath() {
  const user = (process.env.USERNAME || process.env.USER || "user").replace(/[^A-Za-z0-9_.-]/g, "_");
  return `\\\\.\\pipe\\poupou-${user}`;
}

function truncate(value) {
  if (typeof value === "string") {
    return value.length > MAX_FIELD_LEN ? `${value.slice(0, MAX_FIELD_LEN)}…` : value;
  }
  if (Array.isArray(value)) return value.map(truncate);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncate(v);
    return out;
  }
  return value;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", () => resolve(Buffer.alloc(0)));
  });
}

/** Connect, send one line, and — when asked — wait for one line back. */
function talk(line, waitForAnswer) {
  return new Promise((resolve) => {
    let settled = false;
    let answer = "";
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect(pipePath());
    const connectTimer = setTimeout(() => done(null), CONNECT_TIMEOUT);
    socket.on("connect", () => {
      clearTimeout(connectTimer);
      // end(), not destroy(): tearing the pipe down straight after the write
      // loses the line on Windows. The "close" below finishes the run.
      if (waitForAnswer) socket.write(line);
      else socket.end(line);
    });
    socket.on("close", () => done(answer.trim() || null));
    socket.on("data", (chunk) => {
      answer += chunk.toString("utf8");
      if (answer.includes("\n")) done(answer.trim());
    });
    socket.on("end", () => done(answer.trim() || null));
    socket.on("error", () => done(null));
  });
}

/** The documented PermissionRequest output; anything unrecognised prints nothing. */
function permissionRequestJson(decision) {
  let behavior;
  if (decision === "allow") behavior = { behavior: "allow" };
  else if (decision === "deny") behavior = { behavior: "deny", message: "Denied from Poupou" };
  else return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: behavior },
  });
}

/** The chat has no terminal to fall back on, so silence there means "no". */
function chatGateJson(decision) {
  const allow = decision === "allow";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: allow ? "allow" : "deny",
      permissionDecisionReason: allow
        ? "Approved from Poupou"
        : decision === "deny"
          ? "The user denied this from Poupou"
          : "Nobody approved this in Poupou",
    },
  });
}

async function main() {
  let raw = await readStdin();
  if (raw.length === 0) return;
  // Some shells hand us a UTF-8 BOM; JSON.parse would choke on it.
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) raw = raw.subarray(3);

  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;

  if (chatGate) {
    if (CHAT_SAFE_TOOLS.has(payload.tool_name)) return; // normal flow decides
    payload.hook_event_name = "PermissionRequest";
    payload.from_chat = true;
  } else if (typeof payload.hook_event_name !== "string" || !payload.hook_event_name) {
    payload.hook_event_name = arg;
  }
  const event = payload.hook_event_name;

  for (const field of DROPPED_FIELDS) delete payload[field];
  if (typeof payload.cwd !== "string" || !payload.cwd) payload.cwd = process.cwd();
  // Which terminal the session runs in — context only, never a filter.
  if (payload.term_program == null) payload.term_program = process.env.TERM_PROGRAM || "";

  const waits = event === "PermissionRequest";
  // stdout to a pipe is asynchronous on Windows: exit only once it has flushed.
  const deadline = setTimeout(() => {
    if (chatGate) process.stdout.write(`${chatGateJson(null)}\n`, () => process.exit(0));
    else process.exit(0);
  }, waits ? DECISION_BUDGET : FIRE_AND_FORGET_BUDGET);

  const answer = await talk(`${JSON.stringify(truncate(payload))}\n`, waits);
  clearTimeout(deadline);

  if (chatGate) {
    process.stdout.write(`${chatGateJson(answer)}\n`);
  } else if (waits && answer) {
    const json = permissionRequestJson(answer);
    if (json) process.stdout.write(`${json}\n`);
  }
}

// No process.exit() on the way out: everything is closed by then, and exiting
// by hand could cut off the decision still sitting in stdout's buffer.
main().catch(() => {});
