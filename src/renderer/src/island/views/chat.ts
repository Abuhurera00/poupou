// Chat view: bubbles, typing dots and the input bar. Answers come from the local `claude` CLI, so the
// reply is written into its bubble as it streams in.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, onEvent, type ChatContext, type ChatDelta } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";
import { MAX_SECONDS, record, setProgressListener, transcribe, warm, type Recording } from "../voice/voice";

/** Set by the chat view once it exists; the hotkey and the tray call it. */
let voiceToggle: (() => void) | null = null;

/** Start dictating, or stop and transcribe if already listening. */
export function toggleVoice() {
  voiceToggle?.();
}

/** Whisper needs a little audio to work with; anything shorter is a stray click. */
const MIN_SAMPLES = 16000 * 0.4;

/** What went wrong with the microphone, in words a person can act on. */
function micProblem(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone blocked — allow it in your system's privacy settings.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found.";
  if (name === "NotReadableError") return "The microphone is busy in another app.";
  const text = String(err instanceof Error ? err.message : err);
  if (/fetch|network|load/i.test(text)) return "Couldn't download the voice model — check the connection.";
  return `Voice input failed: ${text.slice(0, 80)}`;
}

let nextId = 1;

function bubble(message: ChatMessage): HTMLElement {
  if (message.role === "user") {
    return h(
      "div",
      { class: "chat-row user" },
      h("div", { class: "bubble", text: message.content }),
    );
  }
  return h("div", { class: "chat-row" }, h("div", { class: "reply", text: message.content }));
}

function typingDots(step: string | null): HTMLElement {
  return h(
    "div",
    { class: "chat-row typing-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
    step ? h("span", { class: "typing-step", text: step }) : null,
  );
}

/** The coloured chip showing what the question is about (a dropped file). */
function contextChip(label: string): HTMLElement {
  const chip = h("div", { class: "chip" }, h("i", { class: "chip-dot" }), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

export function buildPrompt(onHeightChange: () => void): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  const input = h("input", {
    type: "text",
    class: "chat-input",
    placeholder: "Ask me anything…",
    spellcheck: "false",
  }) as HTMLInputElement;
  const fresh = h("button", { class: "chat-new", title: "New chat" }, svg(ICONS.plus, 11));
  const mic = h("button", { class: "mic-btn", title: "Speak (Ctrl+Shift+Space)" }, svg(ICONS.mic, 12));
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, fresh, input, mic, send);

  const el = h(
    "div",
    { class: "view" },
    h("div", { class: "card wash chat-card" }, h("div", { class: "chat-body" }, chipRow, log, bar)),
  );
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  /** The reply being streamed into, if any text has arrived yet. */
  // Read through a function: it is written from the event handler while
  // submit() is awaiting, which control-flow narrowing cannot see.
  const stream: { message: ChatMessage | null } = { message: null };
  const streamed = (): ChatMessage | null => stream.message;
  let renderedKey = "";
  let sendIcon = "";

  // ── Voice ───────────────────────────────────────────────────────────────────
  let voice: "idle" | "recording" | "transcribing" = "idle";
  let recording: Recording | null = null;
  let recordStart = 0;
  let meter: number | null = null;
  /** Model download progress (0…1) on first use, null otherwise. */
  let download: number | null = null;
  /** A short message shown in the field, e.g. "No microphone found." */
  let voiceNote: string | null = null;
  let voiceNoteTimer: number | null = null;
  let micIcon = "";

  setProgressListener((fraction) => {
    download = fraction;
    State.notify();
  });

  const note = (text: string) => {
    voiceNote = text;
    if (voiceNoteTimer != null) window.clearTimeout(voiceNoteTimer);
    voiceNoteTimer = window.setTimeout(() => {
      voiceNote = null;
      State.notify();
    }, 4500);
    State.notify();
  };

  const endVoice = () => {
    voice = "idle";
    State.voiceBusy = false;
    recording = null;
    if (meter != null) window.clearInterval(meter);
    meter = null;
    mic.style.setProperty("--level", "0");
    if (!sending && State.stateOverride !== "approval") State.stateOverride = null;
    State.notify();
  };

  async function startVoice() {
    if (sending || voice !== "idle") return;
    voiceNote = null;
    try {
      if ((await Bridge.micAccess()) === false) throw new DOMException("denied", "NotAllowedError");
      recording = await record();
    } catch (err) {
      Sound.play("error");
      note(micProblem(err));
      return;
    }
    // Fetch the model while the user is still talking.
    warm(State.settings.voiceModel);
    voice = "recording";
    State.voiceBusy = true;
    recordStart = performance.now();
    State.stateOverride = "searching";
    Sound.play("peek");
    meter = window.setInterval(() => {
      mic.style.setProperty("--level", (recording?.level() ?? 0).toFixed(2));
      if ((performance.now() - recordStart) / 1000 >= MAX_SECONDS) void stopVoice();
      State.notify(); // the elapsed time in the placeholder
    }, 120);
    State.notify();
  }

  async function stopVoice() {
    if (voice !== "recording" || !recording) return;
    const rec = recording;
    if (meter != null) window.clearInterval(meter);
    meter = null;
    mic.style.setProperty("--level", "0");
    voice = "transcribing";
    State.stateOverride = "thinking";
    Sound.play("blip");
    State.notify();
    try {
      const audio = await rec.stop();
      if (audio.length < MIN_SAMPLES) {
        endVoice();
        note("Didn't catch that — hold on a bit longer.");
        return;
      }
      const s = State.settings;
      const text = await transcribe(audio, s.voiceModel, s.voiceLanguage);
      endVoice();
      if (!text) {
        note("Didn't catch any words.");
        return;
      }
      input.value = input.value.trim() ? `${input.value.trim()} ${text}` : text;
      Sound.play("pop");
      if (State.settings.voiceAutoSend) {
        void submit();
      } else {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } catch (err) {
      endVoice();
      Sound.play("error");
      note(micProblem(err));
    }
  }

  function cancelVoice() {
    recording?.cancel();
    endVoice();
  }

  voiceToggle = () => {
    if (voice === "recording") void stopVoice();
    else if (voice === "idle") void startVoice();
  };

  mic.addEventListener("click", () => voiceToggle?.());

  void onEvent<ChatDelta>("chat-delta", (delta) => {
    if (!sending) return;
    if (delta.step) State.chatStep = delta.step;
    if (delta.text) {
      if (!stream.message) {
        stream.message = { id: nextId++, role: "assistant", content: "" };
        State.chatHistory.push(stream.message);
        onHeightChange();
      }
      stream.message.content += delta.text;
      State.chatStep = null;
    }
    State.notify();
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    input.value = "";
    sending = true;
    State.chatBusy = true;
    stream.message = null;
    Sound.play("send");

    const first = State.chatHistory.length === 0;
    State.chatHistory.push({ id: nextId++, role: "user", content: query });
    State.stateOverride = "thinking";
    State.chatStep = null;
    State.notify();
    onHeightChange();

    const file = State.droppedFile;
    const context: ChatContext | null =
      first && file ? { kind: "file", name: file.name, path: file.path } : null;

    try {
      const reply = await Bridge.chatSend(query, context);
      // The final text is authoritative: deltas can miss a chunk, never the result.
      const done = streamed();
      if (done) done.content = reply.text;
      else State.chatHistory.push({ id: nextId++, role: "assistant", content: reply.text });
      Sound.play("finish");
    } catch (err) {
      const why = String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, "");
      const partial = streamed();
      if (partial && partial.content.trim()) partial.content += `\n\n⚠ ${why}`;
      else if (partial) partial.content = `⚠ ${why}`;
      else State.chatHistory.push({ id: nextId++, role: "assistant", content: `⚠ ${why}` });
      Sound.play("error");
    } finally {
      sending = false;
      State.chatBusy = false;
      stream.message = null;
      State.chatStep = null;
      // An approval card may still own the bot; it clears the override itself.
      if (!State.pendingApproval) State.stateOverride = null;
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  send.addEventListener("click", () => {
    if (sending) void Bridge.chatStop();
    else void submit();
  });
  fresh.addEventListener("click", () => {
    if (sending) return;
    State.chatHistory = [];
    State.droppedFile = null;
    State.promptContext = null;
    void Bridge.chatReset();
    Sound.play("blip");
    State.notify();
    onHeightChange();
    input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && voice === "recording") {
      e.preventDefault();
      e.stopPropagation();
      cancelVoice();
      return;
    }
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      void submit();
    }
    // Escape is the island's to handle (it closes); everything else is typing.
    if ((e as KeyboardEvent).key !== "Escape") e.stopPropagation();
  });

  return {
    el,
    sync() {
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      if (chipRow.dataset.label !== wantChip) {
        chipRow.dataset.label = wantChip;
        clear(chipRow);
        if (wantChip) chipRow.append(contextChip(wantChip));
      }

      const history = State.chatHistory;
      const last = history.at(-1);
      const key = `${history.length}|${sending}|${State.chatStep ?? ""}`;
      if (key !== renderedKey) {
        renderedKey = key;
        clear(log);
        for (const m of history) log.append(bubble(m));
        if (sending) log.append(typingDots(State.chatStep));
        log.scrollTop = log.scrollHeight;
      } else if (last?.role === "assistant") {
        // Same shape, more text: touch only the reply being written.
        const replies = log.querySelectorAll<HTMLElement>(".reply");
        const node = replies[replies.length - 1];
        if (node && node.textContent !== last.content) {
          const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
          node.textContent = last.content;
          if (pinned) log.scrollTop = log.scrollHeight;
        }
      }

      const icon = sending ? ICONS.xmark : ICONS.arrowUp;
      if (icon !== sendIcon) {
        sendIcon = icon;
        clear(send);
        send.append(svg(icon, 11));
        send.title = sending ? "Stop" : "Send";
      }
      fresh.style.display = history.length > 0 && !sending ? "" : "none";

      const micGlyph = voice === "recording" ? ICONS.stop : ICONS.mic;
      if (micGlyph !== micIcon) {
        micIcon = micGlyph;
        clear(mic);
        mic.append(svg(micGlyph, voice === "recording" ? 10 : 12));
      }
      mic.classList.toggle("rec", voice === "recording");
      mic.classList.toggle("busy", voice === "transcribing");
      mic.disabled = sending || voice === "transcribing";
      mic.title = voice === "recording" ? "Stop and transcribe" : "Speak (Ctrl+Shift+Space)";

      const secs = Math.floor((performance.now() - recordStart) / 1000);
      const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      input.placeholder = voiceNote
        ? voiceNote
        : voice === "transcribing" && download != null
          ? `Getting the voice model… ${Math.round(download * 100)}% (first time only)`
          : voice === "recording"
            ? `Listening… ${clock} — click ■ to stop, Esc to cancel`
            : voice === "transcribing"
              ? "Writing it down…"
              : State.claudeReady === false
          ? "Claude CLI not signed in — see Settings…"
          : history.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending || voice !== "idle";
      input.classList.toggle("note", voiceNote != null);
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
