// What Poupou looks like. One place for the silhouette, the skin, the eyes,
// the mouth and the antenna, shared by the live bot, the launch greeting and
// the file-drop sequence so the three can never drift apart.
//
// Poupou is a small ghost: a round dome, straight sides, a hem cut into three
// scallops, warm cream-to-coral skin, round eyes with a glint, and an antenna
// whose bulb lights up in the colour of whatever it is doing.

export const SKIN_TOP = "#FFE9B0";
export const SKIN_BOTTOM = "#FF9C7C";
export const SKIN_MID = "#FFC592";
/** Bulb colour when nothing is going on. */
export const BULB_IDLE = "#FFD45E";
export const INK = "#3B1D2A";

export type Point = readonly [x: number, y: number];

/** How far up the hem's notches cut, as a fraction of the half-height. */
const HEM_DEPTH = 0.24;
/** Where the dome meets the straight sides, as a fraction of the half-height. */
const SHOULDER = -0.08;

/**
 * The outline as a list of points, centred on the origin, `hw` × `hh` half-size.
 * `t` (seconds) makes the hem ripple a little; pass 0 for a still outline.
 */
export function ghostPoints(hw: number, hh: number, t = 0): Point[] {
  const pts: Point[] = [];
  const y0 = hh * SHOULDER;

  // Dome, left shoulder → top → right shoulder.
  const DOME = 36;
  for (let i = 0; i <= DOME; i++) {
    const a = Math.PI + (i / DOME) * Math.PI;
    pts.push([hw * Math.cos(a), y0 + (hh + y0) * Math.sin(a)]);
  }

  // Hem, right → left: three lobes with pointed notches between them.
  const HEM = 54;
  for (let i = 0; i <= HEM; i++) {
    const u = 1 - (i / HEM) * 2;
    const lobe = Math.abs(Math.cos(1.5 * Math.PI * u));
    const ripple = t === 0 ? 0 : Math.sin(t * 2.6 + u * 3.2) * 0.035;
    pts.push([hw * u, hh * (1 - HEM_DEPTH * (1 - lobe) + ripple * lobe)]);
  }
  return pts;
}

/**
 * Builds the path. With `morph` > 0 every point slides towards `target(dirX,
 * dirY)` — the point of another shape in the same direction — which is how the
 * ghost turns into a box when a file is dragged over it.
 */
export function ghostPath(
  hw: number, hh: number, t = 0,
  morph = 0, target?: (ca: number, sa: number) => { x: number; y: number },
): Path2D {
  const path = new Path2D();
  const pts = ghostPoints(hw, hh, t);
  pts.forEach(([px, py], i) => {
    let x = px;
    let y = py;
    if (morph > 0.005 && target) {
      const len = Math.hypot(px, py) || 1;
      const to = target(px / len, py / len);
      x = px + (to.x - px) * morph;
      y = py + (to.y - py) * morph;
    }
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });
  path.closePath();
  return path;
}

/** The point of a superellipse (exponent `n`) in direction (ca, sa). */
export function superellipsePoint(ca: number, sa: number, rx: number, ry: number, n: number) {
  const r = (Math.abs(ca / rx) ** n + Math.abs(sa / ry) ** n) ** (-1 / n);
  return { x: ca * r, y: sa * r };
}

/** Cream at the crown, coral at the hem, with a soft light on one shoulder. */
export function fillSkin(x: CanvasRenderingContext2D, body: Path2D, hw: number, hh: number) {
  const g = x.createLinearGradient(hw * 0.3, -hh, -hw * 0.3, hh);
  g.addColorStop(0, SKIN_TOP);
  g.addColorStop(1, SKIN_BOTTOM);
  x.fillStyle = g;
  x.fill(body);

  const hl = x.createRadialGradient(hw * 0.36, -hh * 0.5, 0, hw * 0.36, -hh * 0.5, hw * 0.75);
  hl.addColorStop(0, "rgba(255,255,255,0.5)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = hl;
  x.fill(body);
}

/** Same skin for the hands, which are plain discs. */
export function skinGradient(x: CanvasRenderingContext2D, r: number): CanvasGradient {
  const g = x.createLinearGradient(r, -r, -r, r);
  g.addColorStop(0, SKIN_TOP);
  g.addColorStop(1, SKIN_MID);
  return g;
}

/**
 * The antenna: a short curved stalk off the crown with a glowing bulb.
 * `k` (0…1) grows it out of the head; draw it before the body so the stalk
 * tucks in behind.
 */
export function drawAntenna(x: CanvasRenderingContext2D, hw: number, hh: number, bulb: string, k = 1, sway = 0) {
  if (k <= 0.02) return;
  const baseY = -hh * 0.94;
  const tipX = (hw * 0.34 + sway * hw) * k;
  const tipY = baseY - hh * 0.46 * k;

  x.save();
  x.lineCap = "round";
  x.strokeStyle = SKIN_MID;
  x.lineWidth = Math.max(1, hh * 0.1);
  x.beginPath();
  x.moveTo(0, baseY + hh * 0.1);
  x.quadraticCurveTo(hw * 0.02, baseY - hh * 0.36 * k, tipX, tipY);
  x.stroke();

  const r = hh * 0.16 * k;
  x.shadowColor = bulb;
  x.shadowBlur = r * 2.2;
  x.fillStyle = bulb;
  x.beginPath();
  x.arc(tipX, tipY, r, 0, Math.PI * 2);
  x.fill();
  x.shadowBlur = 0;
  x.fillStyle = "rgba(255,255,255,0.75)";
  x.beginPath();
  x.arc(tipX - r * 0.3, tipY - r * 0.32, r * 0.3, 0, Math.PI * 2);
  x.fill();
  x.restore();
}

/** A round eye, `w` × `h` nominal, with a glint. `open` 0…1 is the blink. */
export function drawRoundEye(x: CanvasRenderingContext2D, w: number, h: number, open = 1, ink = INK) {
  const rx = w * 0.68;
  const ry = Math.max(h * 0.7 * open, w * 0.14);
  x.fillStyle = ink;
  x.beginPath();
  x.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  x.fill();
  if (open > 0.55) {
    x.fillStyle = "rgba(255,255,255,0.92)";
    x.beginPath();
    x.arc(rx * 0.3, -ry * 0.36, rx * 0.3, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = ink;
  }
}

export type Mouth = "smile" | "grin" | "flat" | "oh" | "none";

/** The mouth, centred on the origin; `s` is the body's half-height. */
export function drawMouth(x: CanvasRenderingContext2D, kind: Mouth, s: number, ink = INK) {
  if (kind === "none") return;
  x.save();
  x.fillStyle = ink;
  x.strokeStyle = ink;
  x.lineCap = "round";
  x.lineWidth = Math.max(0.8, s * 0.075);
  x.beginPath();
  switch (kind) {
    case "smile":
      x.arc(0, -s * 0.1, s * 0.17, Math.PI * 0.18, Math.PI * 0.82);
      x.stroke();
      break;
    case "grin":
      x.arc(0, -s * 0.04, s * 0.19, 0, Math.PI);
      x.closePath();
      x.fill();
      break;
    case "flat":
      x.moveTo(-s * 0.13, 0);
      x.lineTo(s * 0.13, 0);
      x.stroke();
      break;
    case "oh":
      x.ellipse(0, 0, s * 0.09, s * 0.11, 0, 0, Math.PI * 2);
      x.fill();
      break;
  }
  x.restore();
}
