// Voice input: record from the microphone, then turn it into text with the
// local Whisper worker. Nothing leaves the computer.

import type { FromWorker, ToWorker, VoiceModel } from "./worker";

export type { VoiceModel };

/** Whisper hears at 16 kHz. */
const SAMPLE_RATE = 16000;
/** A dictation, not a meeting: recording stops on its own after this. */
export const MAX_SECONDS = 120;

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve(text: string): void; reject(err: Error): void }>();
let onProgress: ((fraction: number | null) => void) | null = null;

/** Where the ONNX runtime files are served, next to the page. */
const ortBase = () => new URL("ort/", window.location.href).href;

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    switch (msg.type) {
      case "progress":
        onProgress?.(msg.total > 0 ? msg.loaded / msg.total : null);
        break;
      case "ready":
        onProgress?.(null);
        break;
      case "result":
        onProgress?.(null);
        waiting.get(msg.id)?.resolve(msg.text);
        waiting.delete(msg.id);
        break;
      case "error":
        onProgress?.(null);
        if (msg.id != null) {
          waiting.get(msg.id)?.reject(new Error(msg.message));
          waiting.delete(msg.id);
        } else {
          console.error("[poupou] voice model", msg.message);
        }
        break;
    }
  };
  return worker;
}

/** Called with 0…1 while the model downloads (first use only), null when done. */
export function setProgressListener(fn: ((fraction: number | null) => void) | null) {
  onProgress = fn;
}

/** Turns 16 kHz mono samples into text. */
export function transcribe(audio: Float32Array, model: VoiceModel, language: string): Promise<string> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    const msg: ToWorker = { type: "transcribe", id, audio, model, language, ortBase: ortBase() };
    getWorker().postMessage(msg, [audio.buffer]);
  });
}

/** Starts loading the model in the background so the first dictation is quick. */
export function warm(model: VoiceModel) {
  const msg: ToWorker = { type: "warm", model, ortBase: ortBase() };
  getWorker().postMessage(msg);
}

// ── Recording ─────────────────────────────────────────────────────────────────

export interface Recording {
  /** Stops and returns the audio, resampled to 16 kHz mono. */
  stop(): Promise<Float32Array>;
  /** Stops and throws the audio away. */
  cancel(): void;
  /** 0…1, how loud it is right now — for the level meter. */
  level(): number;
}

export async function record(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  // A small analyser just for the level meter.
  const meterCtx = new AudioContext();
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 512;
  meterCtx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void meterCtx.close();
  };

  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();

  return {
    async stop() {
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      release();
      const blob = new Blob(chunks, { type: recorder.mimeType });
      // Decoding at 16 kHz resamples for free.
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      try {
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
        return decoded.getChannelData(0).slice();
      } finally {
        void ctx.close();
      }
    },
    cancel() {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
    level() {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.min(1, Math.sqrt(sum / buf.length) * 6);
    },
  };
}
