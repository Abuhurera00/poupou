// Named-pipe server for poupou-hook.
//
// A named pipe on Windows (`\\.\pipe\poupou-<user>`), a socket file in the home
// folder elsewhere — one connection per hook event. Every event is
// forwarded to the island as a `hook` event. A permission request is the only
// one that keeps its connection open: it waits for the island's decision and
// writes it back on the same pipe, which is how approving from the island works.
//
// Claude Code is never blocked by us:
//   * poupou-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island costs a moment, not two minutes;
//   * whatever happens we drop the connection after the decision timeout.
//
// What we write back is the bare word `allow` or `deny`. Turning that into the
// JSON Claude Code expects is poupou-hook's job, so the wire format lives in
// exactly one place.

import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, rmSync } from "node:fs";
import { emit } from "./island";
import { IS_WIN, relayPath } from "./platform";
import { log } from "./store";

/** Slightly under poupou-hook's own 110 s wait, so we always answer first. */
const DECISION_TIMEOUT = 108_000;
/** How long the island gets to say "the card is up". */
const ACK_TIMEOUT = 1_500;
const MAX_PAYLOAD = 1 << 20;

interface Pending {
  socket: Socket;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
let counter = 1;
let server: Server | null = null;

export function startPipe() {
  server = createServer(handle);
  server.on("error", (err) => log(`relay pipe error: ${String(err)}`));
  const path = relayPath();
  // A socket file outlives a crash; a named pipe does not.
  if (!IS_WIN) rmSync(path, { force: true });
  server.listen(path, () => {
    // Our own account only: this socket decides what Claude Code may run.
    if (!IS_WIN) chmodSync(path, 0o600);
    log(`relay listening on ${path}`);
  });
}

export function stopPipe() {
  for (const id of [...pending.keys()]) finish(id, null);
  server?.close();
  server = null;
  if (!IS_WIN) rmSync(relayPath(), { force: true });
}

function handle(socket: Socket) {
  const chunks: Buffer[] = [];
  let size = 0;
  let consumed = false;

  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => {
    if (consumed) return;
    chunks.push(chunk);
    size += chunk.length;
    if (!chunk.includes(0x0a) && size <= MAX_PAYLOAD) return;
    consumed = true;
    const text = Buffer.concat(chunks).toString("utf8");
    dispatch(socket, text.split("\n", 1)[0]);
  });
}

function dispatch(socket: Socket, line: string) {
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    socket.destroy();
    return;
  }

  const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  if (event !== "PermissionRequest") {
    log(`hook ${event}`);
    emit("hook", payload);
    socket.end();
    return;
  }

  const id = `${process.pid}-${counter++}`;
  payload.request_id = id;
  log(`hook PermissionRequest id=${id}${payload.from_chat === true ? " (chat)" : ""}`);

  // First the short wait for "the card is up", then the long one for a human.
  const timer = setTimeout(() => {
    log(`hook id=${id} island never acknowledged — terminal takes over`);
    finish(id, null);
  }, ACK_TIMEOUT);
  pending.set(id, { socket, timer });

  // The relay went away (its own deadline, or the session was stopped): the
  // card must not stay up pretending somebody is still listening.
  socket.on("close", () => {
    if (!pending.has(id)) return;
    clearTimeout(pending.get(id)!.timer);
    pending.delete(id);
    log(`hook id=${id} relay hung up`);
    emit("approval-gone", id);
  });

  emit("hook", payload);
}

/** Writes the decision (or nothing) and closes the connection. */
function finish(id: string, decision: string | null) {
  const entry = pending.get(id);
  if (!entry) {
    log(`reply for id=${id} — no pending request`);
    return;
  }
  clearTimeout(entry.timer);
  pending.delete(id);
  // No decision: say nothing at all. poupou-hook then prints nothing and Claude
  // Code asks in the terminal, exactly as if Poupou were closed.
  if (decision) entry.socket.end(`${decision}\n`);
  else entry.socket.end();
}

/** The island has the card on screen; the long wait may begin. */
export function acknowledge(id: string) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    log(`hook id=${id} timed out — terminal takes over`);
    finish(id, null);
  }, DECISION_TIMEOUT);
}

/** Nobody can act on this one — paused, or another card already holds the view. */
export function decline(id: string) {
  log(`decline id=${id}`);
  finish(id, null);
}

/** Called by the island's Allow / Deny buttons. Only ever a bare word. */
export function answer(id: string, decision: string) {
  const word = decision === "allow" ? "allow" : "deny";
  log(`decision id=${id} ${word}`);
  finish(id, word);
}
