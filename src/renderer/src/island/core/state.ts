// App state: what the island shows and what it is waiting on.

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../bot/engine";

export type AgentSource = "claudeCode";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  tool: string;
  command: string;
  /** True when the island's own chat is asking, not a Claude Code session. */
  fromChat: boolean;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export type PromptContext = { kind: "file"; name: string; path?: string };

/** The one agent the island follows: Claude Code, wherever it runs. */
export const CLAUDE_ID = "integration_claude";

const CLAUDE_AGENT: AgentTask = {
  id: CLAUDE_ID,
  name: "VS Code",
  color: "#F5F6F8",
  state: "idle",
  stepIndex: 0,
  steps: [],
  source: "claudeCode",
  isIntegration: true,
};

/** What the chat may do on its own. */
export type ChatAccess = "ask" | "readonly";

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  screen: "primary" | "cursor";
  hooksInstalled: boolean;
  /** Model alias handed to the `claude` CLI; empty = the CLI's own default. */
  model: string;
  /** Folder the chat works in. Empty = the home directory. */
  chatCwd: string;
  /** "ask": tools that change things need a click. "readonly": they are refused. */
  chatAccess: ChatAccess;
  /** Start with the computer (built app only). */
  autostart: boolean;
  /** Speech model size: bigger hears better and downloads more. */
  voiceModel: "tiny" | "base" | "small";
  /** Spoken language as a Whisper code ("en", "ur"…); empty = detect it. */
  voiceLanguage: string;
  /** Send the message as soon as it is transcribed, instead of waiting for Enter. */
  voiceAutoSend: boolean;
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
  autostart: false,
  voiceModel: "base",
  voiceLanguage: "",
  voiceAutoSend: false,
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left. */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  chatHistory: ChatMessage[] = [];
  /** What the chat is doing right now ("Read · notes.md"), shown by the typing dots. */
  chatStep: string | null = null;
  /** True from the moment a message is sent until its reply is complete. */
  chatBusy = false;
  /** True while dictating or transcribing. */
  voiceBusy = false;

  /** Something the user is in the middle of: the island must not close on them. */
  get busy(): boolean {
    return this.chatBusy || this.voiceBusy;
  }
  pendingApproval: ApprovalInfo | null = null;

  /** Whether the `claude` CLI is installed and logged in; null until checked. */
  claudeReady: boolean | null = null;

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    t.pillBadge = null;
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** Puts the Claude Code agent in place. */
  loadTasks() {
    if (!this.tasks.some((t) => t.id === CLAUDE_ID)) this.tasks.push({ ...CLAUDE_AGENT, steps: [] });
    if (!this.focusId) this.focusId = CLAUDE_ID;
    this.notify();
  }

  defaultView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }
}

export const State = new AppState();
