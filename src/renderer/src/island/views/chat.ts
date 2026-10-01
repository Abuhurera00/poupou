// Chat view: bubbles, typing dots and the input bar. Answers come from the local `claude` CLI, so the
// reply is written into its bubble as it streams in.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, onEvent, type ChatContext, type ChatDelta } from "../core/bridge";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import type { ViewHost } from "./views";

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
  const send = h("button", { class: "send-btn", title: "Send" }, svg(ICONS.arrowUp, 11));
  const bar = h("div", { class: "chat-bar" }, fresh, input, send);

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

      input.placeholder =
        State.claudeReady === false
          ? "Claude CLI not signed in — see Settings…"
          : history.length === 0 ? "Ask me anything…" : "Continue…";
      input.disabled = sending;
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
