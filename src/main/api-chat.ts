// The chat over the Anthropic API directly, for an API key on a computer
// without Claude Code. It answers and searches the web; it cannot read files on
// disk or run commands — that needs Claude Code (see claude.ts).

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { emit } from "./island";
import { log, type Settings } from "./store";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

const SYSTEM_PROMPT = `You are Poupou, a small assistant living in a notch-sized panel at the top of the user's screen. Replies are shown in a narrow chat bubble that renders plain text only.

Be direct and brief: answer first, a few short lines at most unless the task truly needs more. Reply in the user's language. No markdown at all — no **, no #, no backticks, no tables, no bullet dashes. Use plain sentences and line breaks.

You can search the web. You cannot open files on the user's computer or run commands from here; if they ask for that, say it needs Claude Code installed, in one line.`;

/** Settings → Model, mapped to current model IDs. Empty means the default. */
const MODELS: Record<string, string> = {
  "": "claude-opus-5-5",
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/** Models that take the dynamic-filtering web search and server-side fallbacks. */
const FULL_FEATURES = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

/** Files read straight into the first message; anything bigger is refused. */
const MAX_INLINE_TEXT = 200_000;
const MAX_BINARY = 20 * 1024 * 1024;

let history: MessageParam[] = [];
let running: AbortController | null = null;

export type ChatContext = { kind: "file"; name: string; path: string };

/** A dropped file as content blocks: PDFs and images as themselves, text inline. */
function fileBlocks(context: ChatContext): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  const ext = extname(context.path).toLowerCase();
  const size = statSync(context.path).size;
  const images: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  };
  if (ext === ".pdf" || images[ext]) {
    if (size > MAX_BINARY) throw new Error(`${context.name} is too big to send (over 20 MB).`);
    const data = readFileSync(context.path).toString("base64");
    return ext === ".pdf"
      ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }]
      : [{ type: "image", source: { type: "base64", media_type: images[ext], data } }];
  }
  if (size > MAX_INLINE_TEXT) throw new Error(`${context.name} is too big to read here (over 200 KB of text).`);
  return [{ type: "text", text: `File ${context.name}:\n\n${readFileSync(context.path, "utf8")}` }];
}

/**
 * What goes back into the history. After a mid-answer fallback to another
 * model, only the text before the last fallback marker may be echoed; the rest
 * of the content carries over unchanged.
 */
function forHistory(content: ContentBlock[]): ContentBlock[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf("fallback");
  if (lastFallback < 0) return content;
  return content.filter((b, i) => i > lastFallback || b.type === "text");
}

export async function apiChatSend(
  settings: Settings,
  apiKey: string,
  query: string,
  context: ChatContext | null,
): Promise<{ text: string }> {
  if (running) throw new Error("Still answering the previous message.");

  const model = MODELS[settings.model] ?? MODELS[""];
  const full = FULL_FEATURES.has(model);
  const client = new Anthropic({ apiKey, maxRetries: 2 });

  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = context ? fileBlocks(context) : [];
  content.push({ type: "text", text: query });
  const turn: MessageParam[] = [{ role: "user", content }];

  const controller = new AbortController();
  running = controller;
  const startedAt = Date.now();
  log(`api chat turn started (${model})`);

  try {
    // A long web search can pause the turn; carry on from where it stopped.
    for (let leg = 0; leg < 4; leg++) {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 64000,
          system: SYSTEM_PROMPT,
          messages: [...history, ...turn],
          output_config: { effort: "medium" },
          tools: full ? [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }] : [],
          // On a safety decline, let Anthropic re-run the request on the right model.
          ...(full ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "server_tool_use") {
          emit("chat-delta", { step: "Searches the web" });
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          emit("chat-delta", { text: event.delta.text });
        }
      }
      const message = await stream.finalMessage();

      if (message.stop_reason === "refusal") {
        throw new Error(message.stop_details?.explanation || "Claude declined to answer that one.");
      }
      turn.push({ role: "assistant", content: forHistory(message.content) });
      if (message.stop_reason !== "pause_turn") break;
    }

    // The whole turn is kept only once it succeeded, so a failure leaves the
    // conversation exactly as Claude last saw it.
    history = [...history, ...turn];
    const text = turn
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    log(`api chat turn done in ${Date.now() - startedAt} ms`);
    if (!text) throw new Error("No answer came back.");
    return { text };
  } catch (err) {
    if (controller.signal.aborted) throw new Error("Stopped.");
    if (err instanceof Anthropic.AuthenticationError) throw new Error("Your API key was rejected — update it in Settings.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("Rate limited by Anthropic — try again in a moment.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Anthropic — are you online?");
    if (err instanceof Anthropic.APIError) {
      log(`api chat failed: ${err.status} ${err.message}`);
      throw new Error(`Anthropic API error${err.status ? ` ${err.status}` : ""}: ${err.message}`);
    }
    throw err;
  } finally {
    running = null;
  }
}

export function apiChatStop() {
  running?.abort();
}

export function apiChatReset() {
  apiChatStop();
  history = [];
}
