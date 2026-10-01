// Draws the app icon into build/icon.png (1024×1024). electron-builder turns
// that one file into the .ico for Windows and the .icns for macOS.
//
//   npm run icon
//
// It is Poupou on a dark rounded tile, drawn from the same shape and colours as
// the tray icon (src/main/tray.ts) and the bot itself
// (src/renderer/src/island/bot/look.ts). Change the look there and here together.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const SS = 3; // supersampling, for smooth edges
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../build/icon.png");

const SKIN_TOP = [255, 233, 176];
const SKIN_BOTTOM = [255, 156, 124];
const BULB = [255, 212, 94];
const STALK = [255, 197, 146];
const INK = [59, 29, 42];
const TILE_TOP = [34, 36, 42];
const TILE_BOTTOM = [14, 15, 18];

const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

/** Distance from point p to segment a–b. */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** Colour at (u, v) in the unit square, or null where the icon is transparent. */
function sample(u, v) {
  // The tile: a rounded square with a little margin, as app icons have.
  const m = 0.06;
  const r = 0.21;
  const qx = Math.max(Math.abs(u - 0.5) - (0.5 - m - r), 0);
  const qy = Math.max(Math.abs(v - 0.5) - (0.5 - m - r), 0);
  if (Math.hypot(qx, qy) > r) return null;
  const tile = mix(TILE_TOP, TILE_BOTTOM, v);

  // Poupou, centred on the tile.
  const x = u - 0.5;
  const hw = 0.235;
  const top = 0.33;
  const bottom = 0.8;
  const hh = (bottom - top) / 2;
  const cy = top + hh;
  const shoulder = cy - hh * 0.08;

  // Antenna: bulb, then the stalk it sits on.
  const bulbX = 0.085;
  const bulbY = 0.235;
  const d = Math.hypot(x - bulbX, v - bulbY);
  if (d <= 0.042) return Math.hypot(x - bulbX + 0.013, v - bulbY + 0.014) <= 0.012 ? [255, 255, 255] : BULB;
  if (segDist(x, v, 0, top + 0.02, bulbX, bulbY) <= 0.012) return STALK;

  let inside;
  if (v < shoulder) inside = (x / hw) ** 2 + ((v - shoulder) / (shoulder - top)) ** 2 <= 1;
  else inside = Math.abs(x) <= hw && v <= cy + hh * (1 - 0.24 * (1 - Math.abs(Math.cos((1.5 * Math.PI * x) / hw))));
  if (!inside) {
    // A soft glow from the bulb on the tile.
    return d < 0.16 ? mix(tile, BULB, 0.22 * (1 - d / 0.16) ** 2) : tile;
  }

  const eyeY = cy - hh * 0.14;
  for (const side of [-1, 1]) {
    const ex = x - side * 0.092;
    if ((ex / 0.036) ** 2 + ((v - eyeY) / 0.045) ** 2 <= 1) {
      return Math.hypot(ex - 0.011, v - eyeY + 0.016) <= 0.011 ? [255, 255, 255] : INK;
    }
  }
  // Smile: the lower part of a thin ring.
  const sm = Math.hypot(x, v - (eyeY + 0.062));
  if (v > eyeY + 0.062 + 0.012 && Math.abs(sm - 0.036) <= 0.0085) return INK;

  return mix(SKIN_TOP, SKIN_BOTTOM, (v - top) / (bottom - top));
}

// ── Render ────────────────────────────────────────────────────────────────────

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let py = 0; py < SIZE; py++) {
  const row = py * (SIZE * 4 + 1);
  raw[row] = 0; // PNG filter: none
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample((px + (sx + 0.5) / SS) / SIZE, (py + (sy + 0.5) / SS) / SIZE);
        if (!c) continue;
        hits++;
        r += c[0];
        g += c[1];
        b += c[2];
      }
    }
    const i = row + 1 + px * 4;
    if (hits) {
      raw[i] = Math.round(r / hits);
      raw[i + 1] = Math.round(g / hits);
      raw[i + 2] = Math.round(b / hits);
    }
    raw[i + 3] = Math.round((255 * hits) / (SS * SS));
  }
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log(`icon → ${OUT}`);
