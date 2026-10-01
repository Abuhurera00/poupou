// Notification-area icon and its menu. The icon is Poupou drawn in code — the
// same ghost as on the island — so there is no image file to ship.

import { Menu, Tray, app, nativeImage, type NativeImage } from "electron";

export interface TrayActions {
  open(): void;
  chat(): void;
  settings(): void;
  pause(): void;
}

let tray: Tray | null = null;

type RGB = [number, number, number];
// Kept in step with src/renderer/src/island/bot/look.ts.
const SKIN_TOP: RGB = [255, 233, 176];
const SKIN_BOTTOM: RGB = [255, 156, 124];
const BULB: RGB = [255, 212, 94];
const INK: RGB = [59, 29, 42];

/** The colour of the icon at one point (unit square, origin top-left), or null outside it. */
function sample(u: number, v: number): RGB | null {
  const x = u - 0.5;
  const hw = 0.37;
  const top = 0.24;
  const bottom = 0.97;
  const hh = (bottom - top) / 2;
  const cy = top + hh;
  const shoulder = cy - hh * 0.08;

  // Antenna bulb, above the head.
  if (Math.hypot(x - 0.15, v - 0.12) <= 0.1) return BULB;

  let inside: boolean;
  if (v < shoulder) inside = (x / hw) ** 2 + ((v - shoulder) / (shoulder - top)) ** 2 <= 1;
  else inside = Math.abs(x) <= hw && v <= cy + hh * (1 - 0.24 * (1 - Math.abs(Math.cos((1.5 * Math.PI * x) / hw))));
  if (!inside) return null;

  const eyeY = cy - hh * 0.12;
  for (const side of [-1, 1]) {
    if (((x - side * 0.15) / 0.065) ** 2 + ((v - eyeY) / 0.085) ** 2 <= 1) return INK;
  }
  const k = Math.max(0, Math.min(1, (v - top) / (bottom - top)));
  return [0, 1, 2].map((i) => SKIN_TOP[i] + (SKIN_BOTTOM[i] - SKIN_TOP[i]) * k) as RGB;
}

export function drawIcon(size: number, scaleFactor = 1): NativeImage {
  const SS = 4; // supersampling, for smooth edges
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (!c) continue;
          hits++;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const total = SS * SS;
      const i = (py * size + px) * 4;
      // BGRA, premultiplied: summing over hits and dividing by all samples does both.
      buf[i] = Math.round(b / total);
      buf[i + 1] = Math.round(g / total);
      buf[i + 2] = Math.round(r / total);
      buf[i + 3] = Math.round((255 * hits) / total);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor });
}

export function buildTray(actions: TrayActions) {
  // The macOS menu bar wants an 18-point icon; drawn at 2× it stays sharp on Retina.
  tray = new Tray(process.platform === "darwin" ? drawIcon(36, 2) : drawIcon(32));
  tray.setToolTip("Poupou");
  let paused = false;

  const refresh = () => {
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open", click: actions.open },
        { label: "Ask Claude", click: actions.chat },
        { label: "Settings…", click: actions.settings },
        { type: "separator" },
        {
          label: "Pause",
          type: "checkbox",
          checked: paused,
          click: () => {
            paused = !paused;
            actions.pause();
            refresh();
          },
        },
        { type: "separator" },
        { label: "Quit Poupou", click: () => app.quit() },
      ]),
    );
  };
  refresh();
  tray.on("click", actions.open);
}
