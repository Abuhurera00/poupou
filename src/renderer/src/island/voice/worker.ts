// Speech to text, entirely on this computer: OpenAI's Whisper model running in
// WebAssembly through transformers.js. The model is downloaded from Hugging Face
// the first time and cached; after that no audio and no network is involved.
//
// Runs in a worker so a transcription never stalls the island's animation.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

export type VoiceModel = "tiny" | "base" | "small";

export type ToWorker =
  | { type: "transcribe"; id: number; audio: Float32Array; model: VoiceModel; language: string; ortBase: string }
  | { type: "warm"; model: VoiceModel; ortBase: string };

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready" }
  | { type: "result"; id: number; text: string }
  | { type: "error"; id: number | null; message: string };

const REPO: Record<VoiceModel, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
};

let loaded: { model: VoiceModel; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

const post = (msg: FromWorker) => (self as unknown as Worker).postMessage(msg);

function load(model: VoiceModel, ortBase: string): Promise<AutomaticSpeechRecognitionPipeline> {
  if (loaded?.model === model) return loaded.asr;

  // The runtime ships with the app instead of coming from a CDN.
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = {
      mjs: `${ortBase}ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${ortBase}ort-wasm-simd-threaded.asyncify.wasm`,
    };
  }
  env.useWasmCache = false;
  env.allowLocalModels = false;

  // Download progress across all of the model's files.
  const files = new Map<string, { loaded: number; total: number }>();
  const asr = pipeline("automatic-speech-recognition", REPO[model], {
    device: "wasm",
    // A quantised encoder costs Whisper a lot of accuracy; the decoder takes it well.
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== "progress" || !p.file) return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let done = 0;
      let all = 0;
      for (const f of files.values()) {
        done += f.loaded;
        all += f.total;
      }
      post({ type: "progress", loaded: done, total: all });
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>;

  loaded = { model, asr };
  // A failed download must not be remembered as the model.
  asr.catch(() => {
    if (loaded?.asr === asr) loaded = null;
  });
  return asr;
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  try {
    const asr = await load(msg.model, msg.ortBase);
    if (msg.type === "warm") {
      post({ type: "ready" });
      return;
    }
    const out = await asr(msg.audio, {
      language: msg.language || undefined,
      task: "transcribe",
      // Longer than Whisper's 30 s window: transcribe in overlapping pieces.
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
    post({ type: "result", id: msg.id, text });
  } catch (err) {
    post({ type: "error", id: msg.type === "transcribe" ? msg.id : null, message: String(err instanceof Error ? err.message : err) });
  }
};
