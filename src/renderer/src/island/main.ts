// Entry point: boot the bridge, wire the island, start the greeting.

import "./style.css";
import { Bridge, IS_NATIVE, onEvent } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { toggleVoice } from "./views/chat";

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
  }
  island.applySettings();
  State.loadTasks();

  onEvent<{ x: number; y: number }>("cursor", ({ x, y }) => island.onCursor(x, y));

  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  onEvent<string>("tray", (what) => {
    switch (what) {
      case "open":
        setPaused(false);
        island.alert(State.defaultView());
        break;
      case "chat":
        setPaused(false);
        island.alert("prompt");
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  onEvent<null>("screen-changed", () => void Bridge.reposition());
  onEvent<null>("wake", () => island.wake());

  // Ctrl+Shift+Space (or the tray): open the chat and start or stop dictating.
  onEvent<null>("voice", () => {
    if (State.paused) return;
    const opening = !(State.mode === "expanded" && State.view === "prompt");
    if (opening) island.alert("prompt");
    // Let the chat view settle in before the microphone starts.
    window.setTimeout(toggleVoice, opening ? 260 : 0);
  });

  // The settings window writes preferences; apply them here without a restart.
  onEvent<Settings>("settings-changed", (s) => {
    State.settings = { ...State.settings, ...s };
    island.applySettings();
  });

  registerHookHandlers(island);

  // Knowing early lets the chat field say what's missing instead of failing.
  const checkReady = () =>
    void Bridge.chatReady().then((status) => {
      if (!status) return;
      State.claudeReady = status.ready;
      State.notify();
    });
  checkReady();
  onEvent<null>("chat-ready-changed", checkReady);

  island.launch();

  // In a plain browser nothing unlocks audio for us: wait for the first click.
  if (!IS_NATIVE) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
