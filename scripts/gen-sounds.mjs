// Generates every island sound into src/renderer/public/sounds.
//
//   npm run sounds
//
// The sounds are synthesised here from nothing but sine waves and noise, so
// they are ours to ship and easy to retune: change a note or a length below and
// run the script again. The voice is a soft mallet — a sine with a little
// second and third harmonic that die away faster than the fundamental — which
// stays pleasant at the low volume the island plays at.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../src/renderer/public/sounds");

// ── Notes ─────────────────────────────────────────────────────────────────────

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" → 440, "C#5", "Eb4"… */
function note(name) {
  const m = /^([A-G])([#b]?)(\d)$/.exec(name);
  if (!m) throw new Error(`bad note: ${name}`);
  const semi = SEMITONES[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return 440 * 2 ** ((semi - 9 + (Number(m[3]) - 4) * 12) / 12);
}
const hz = (v) => (typeof v === "string" ? note(v) : v);

// ── Synth ─────────────────────────────────────────────────────────────────────

class Clip {
  constructor(seconds) {
    this.data = new Float32Array(Math.ceil(seconds * SR));
  }

  /**
   * One pitched voice. `from`/`to` glide exponentially over `dur`; the envelope
   * is a short linear attack into an exponential decay with time constant `decay`.
   */
  tone({ at = 0, dur, from, to = from, gain = 1, attack = 0.004, decay = dur / 3, wave = "mallet", vibrato = null }) {
    const f0 = hz(from);
    const f1 = hz(to);
    const n = Math.floor(dur * SR);
    const start = Math.floor(at * SR);
    let phase = 0;
    for (let i = 0; i < n && start + i < this.data.length; i++) {
      const t = i / SR;
      let f = f0 * (f1 / f0) ** (t / dur);
      if (vibrato) f *= 1 + vibrato.depth * Math.sin(2 * Math.PI * vibrato.rate * t);
      phase += (2 * Math.PI * f) / SR;

      let s;
      if (wave === "sine") s = Math.sin(phase);
      else if (wave === "reed") {
        // Odd harmonics: hollow and a little nasal, for the grumpy sounds.
        s = Math.sin(phase) + 0.33 * Math.sin(3 * phase) + 0.14 * Math.sin(5 * phase);
        s *= 0.7;
      } else {
        const bright = Math.exp(-t / (decay * 0.35));
        s = Math.sin(phase) + bright * (0.28 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
        s *= 0.8;
      }

      const env = Math.min(1, t / attack) * Math.exp(-t / decay) * Math.min(1, (dur - t) / 0.006);
      this.data[start + i] += s * env * gain;
    }
    return this;
  }

  /** Filtered noise: a one-pole low-pass whose cutoff sweeps from `from` to `to`. */
  noise({ at = 0, dur, from = 4000, to = from, gain = 1, attack = 0.002, decay = dur / 3 }) {
    const n = Math.floor(dur * SR);
    const start = Math.floor(at * SR);
    let seed = 12345;
    let low = 0;
    for (let i = 0; i < n && start + i < this.data.length; i++) {
      const t = i / SR;
      seed = (seed * 1664525 + 1013904223) >>> 0; // same noise every run
      const white = seed / 2 ** 31 - 1;
      const cutoff = from * (to / from) ** (t / dur);
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
      low += a * (white - low);
      const env = Math.min(1, t / attack) * Math.exp(-t / decay) * Math.min(1, (dur - t) / 0.006);
      this.data[start + i] += low * env * gain;
    }
    return this;
  }

  /** A few quiet repeats, for the sounds that should hang in the air. */
  echo({ delay = 0.11, feedback = 0.35, repeats = 3 } = {}) {
    const d = Math.floor(delay * SR);
    const dry = Float32Array.from(this.data);
    for (let r = 1; r <= repeats; r++) {
      const g = feedback ** r;
      for (let i = 0; i + r * d < this.data.length; i++) this.data[i + r * d] += dry[i] * g;
    }
    return this;
  }

  /** Notes played one after another: [[note, seconds], …]. */
  melody(notes, { at = 0, gain = 1, ring = 1.6, wave = "mallet" } = {}) {
    let t = at;
    for (const [n, len] of notes) {
      this.tone({ at: t, dur: Math.min(len * ring + 0.12, this.data.length / SR - t), from: n, gain, decay: len * 0.9, wave });
      t += len;
    }
    return this;
  }

  wav() {
    let peak = 0;
    for (const v of this.data) peak = Math.max(peak, Math.abs(v));
    const scale = peak > 0 ? 0.82 / peak : 0;
    const fade = Math.floor(0.008 * SR);
    const pcm = Buffer.alloc(this.data.length * 2);
    for (let i = 0; i < this.data.length; i++) {
      const tail = Math.min(1, (this.data.length - i) / fade);
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, this.data[i] * scale * tail)) * 32767), i * 2);
    }
    const head = Buffer.alloc(44);
    head.write("RIFF", 0);
    head.writeUInt32LE(36 + pcm.length, 4);
    head.write("WAVEfmt ", 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); // PCM
    head.writeUInt16LE(1, 22); // mono
    head.writeUInt32LE(SR, 24);
    head.writeUInt32LE(SR * 2, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write("data", 36);
    head.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([head, pcm]);
  }
}

const clip = (seconds) => new Clip(seconds);

// ── The sounds ────────────────────────────────────────────────────────────────
// Everything sits in D major pentatonic (D E F# A B), so sounds that overlap —
// and they do — never clash.

const SOUNDS = {
  // Island movement
  peek: () => clip(0.3).tone({ dur: 0.26, from: "A4", to: "D5", decay: 0.09, gain: 0.9 }).noise({ dur: 0.12, from: 900, to: 3200, gain: 0.12, decay: 0.05 }),
  open: () => clip(0.42).melody([["D5", 0.075], ["A5", 0.2]]).noise({ dur: 0.16, from: 600, to: 5000, gain: 0.1, decay: 0.07 }),
  close: () => clip(0.36).melody([["A5", 0.07], ["D5", 0.18]], { gain: 0.9 }).noise({ dur: 0.14, from: 4000, to: 500, gain: 0.08, decay: 0.06 }),
  hover: () => clip(0.07).tone({ dur: 0.06, from: "F#6", decay: 0.018, gain: 0.7, wave: "sine" }),
  blip: () => clip(0.1).tone({ dur: 0.09, from: "A5", to: "B5", decay: 0.03 }),
  tick: () => clip(0.06).tone({ dur: 0.05, from: "D6", decay: 0.012, wave: "sine" }).noise({ dur: 0.012, from: 6000, gain: 0.2, decay: 0.004 }),
  pop: () => clip(0.2).tone({ dur: 0.14, from: 260, to: 1100, decay: 0.035, wave: "sine" }),

  // Being poked
  slap: () => clip(0.3).noise({ dur: 0.09, from: 5000, to: 700, gain: 0.9, decay: 0.022 }).tone({ dur: 0.2, from: 210, to: 95, decay: 0.05, wave: "sine", gain: 0.9 }),
  annoyed: () => clip(0.5).tone({ dur: 0.16, from: "F#4", to: "E4", decay: 0.09, wave: "reed" }).tone({ at: 0.17, dur: 0.3, from: "E4", to: "B3", decay: 0.13, wave: "reed" }),
  dizzy: () => clip(0.95).tone({ dur: 0.9, from: "B5", to: "D4", decay: 0.5, wave: "sine", vibrato: { rate: 9, depth: 0.06 } }).tone({ at: 0.05, dur: 0.85, from: "F#5", to: "A3", decay: 0.45, wave: "sine", gain: 0.5, vibrato: { rate: 6.5, depth: 0.08 } }),

  // Character
  greet: () => clip(0.85).melody([["D5", 0.09], ["F#5", 0.09], ["A5", 0.09], ["D6", 0.3]]).echo({ delay: 0.12, feedback: 0.22, repeats: 2 }),
  love: () => clip(0.8).tone({ dur: 0.7, from: "F#5", decay: 0.3, gain: 0.8, vibrato: { rate: 6, depth: 0.004 } }).tone({ at: 0.11, dur: 0.6, from: "A5", decay: 0.28, gain: 0.7 }).tone({ at: 0.22, dur: 0.55, from: "D6", decay: 0.26, gain: 0.6 }),
  proud: () => clip(0.8).melody([["A4", 0.1], ["D5", 0.1], ["F#5", 0.1], ["A5", 0.34]], { ring: 2 }).tone({ at: 0.3, dur: 0.45, from: "D5", decay: 0.2, gain: 0.45 }),
  wink: () => clip(0.2).tone({ dur: 0.07, from: "B5", decay: 0.03 }).tone({ at: 0.07, dur: 0.11, from: "E6", decay: 0.04 }),
  yawn: () => clip(0.75).tone({ dur: 0.25, from: "E4", to: "B4", decay: 0.3, wave: "sine", attack: 0.06 }).tone({ at: 0.25, dur: 0.48, from: "B4", to: "D4", decay: 0.22, wave: "sine", attack: 0.01 }),
  sleep: () => clip(0.6).melody([["A4", 0.14], ["F#4", 0.14], ["D4", 0.26]], { gain: 0.8, wave: "sine" }),

  // Claude Code session
  work: () => clip(0.34).melody([["D4", 0.09], ["A4", 0.18]], { gain: 0.9 }),
  think: () => clip(0.45).tone({ dur: 0.2, from: "E5", decay: 0.08, gain: 0.7, wave: "sine" }).tone({ at: 0.16, dur: 0.26, from: "F#5", decay: 0.1, gain: 0.7, wave: "sine" }),
  search: () => clip(0.6).tone({ dur: 0.18, from: "A5", to: "B5", decay: 0.06, wave: "sine" }).echo({ delay: 0.13, feedback: 0.42, repeats: 3 }),
  finish: () => clip(1.05).melody([["D5", 0.1], ["F#5", 0.1], ["A5", 0.1], ["D6", 0.12], ["F#6", 0.4]], { ring: 2.2 }).echo({ delay: 0.14, feedback: 0.2, repeats: 2 }),
  error: () => clip(0.7).tone({ dur: 0.2, from: "F4", decay: 0.1, wave: "reed" }).tone({ at: 0.2, dur: 0.45, from: "B3", decay: 0.2, wave: "reed" }),
  rate: () => clip(0.6).tone({ dur: 0.16, from: "E4", decay: 0.08, wave: "reed", gain: 0.9 }).tone({ at: 0.2, dur: 0.16, from: "E4", decay: 0.08, wave: "reed", gain: 0.9 }).tone({ at: 0.4, dur: 0.18, from: "D4", decay: 0.09, wave: "reed", gain: 0.8 }),
  approval: () => clip(0.8).tone({ dur: 0.2, from: "A5", decay: 0.08 }).tone({ at: 0.16, dur: 0.2, from: "A5", decay: 0.08 }).tone({ at: 0.34, dur: 0.42, from: "E6", decay: 0.18 }),
  question: () => clip(0.62).tone({ dur: 0.16, from: "F#5", decay: 0.08 }).tone({ at: 0.15, dur: 0.42, from: "A5", to: "D6", decay: 0.2 }),
  approve: () => clip(0.5).melody([["F#5", 0.08], ["D6", 0.3]], { ring: 1.4 }),

  // Chat and files
  send: () => clip(0.4).noise({ dur: 0.3, from: 500, to: 7000, gain: 0.3, attack: 0.05, decay: 0.12 }).tone({ dur: 0.26, from: "D5", to: "D6", decay: 0.1, gain: 0.7, wave: "sine" }),
  gulp: () => clip(0.55).tone({ dur: 0.2, from: 420, to: 170, decay: 0.12, wave: "sine" }).tone({ at: 0.22, dur: 0.22, from: 190, to: 620, decay: 0.07, wave: "sine", gain: 0.9 }),
  attach: () => clip(0.5).noise({ dur: 0.02, from: 5000, gain: 0.5, decay: 0.006 }).tone({ at: 0.03, dur: 0.14, from: "A4", decay: 0.05 }).tone({ at: 0.14, dur: 0.32, from: "E5", decay: 0.13 }),
};

mkdirSync(OUT, { recursive: true });
for (const [name, build] of Object.entries(SOUNDS)) {
  const file = build().wav();
  writeFileSync(join(OUT, `${name}.wav`), file);
  console.log(`${name.padEnd(9)} ${((file.length - 44) / 2 / SR).toFixed(2)} s`);
}
console.log(`${Object.keys(SOUNDS).length} sounds → ${OUT}`);
