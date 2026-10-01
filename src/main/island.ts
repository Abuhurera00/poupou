// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the display inside a borderless, transparent, always-on-top window
// that never takes focus.

import { BrowserWindow, screen } from "electron";
import { join } from "node:path";

/** Logical size of the full window — the largest island view. */
const PANEL_W = 720;
const PANEL_H = 320;
/** Logical size of the invisible strip that wakes the island when it is hidden. */
const STRIP_W = 240;
const STRIP_H = 6;

/** Margin around the island that still counts as "on the island", in logical px. */
const HIT_MARGIN = 14;

const POLL_MS = 16;

let win: BrowserWindow | null = null;
let collapsed = false;
let screenPref: "primary" | "cursor" = "primary";
/** The island shape in window coordinates, pushed by the front end. */
let rect = { x: 0, y: 0, w: 0, h: 0 };
let ignoring = false;
let poll: NodeJS.Timeout | null = null;
let last = { x: Number.NaN, y: Number.NaN };

export const islandWindow = () => win;

/** Sends an event to the island page. */
export function emit(name: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send("poupou:event", name, payload);
}

function targetDisplay() {
  if (screenPref === "cursor") return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return screen.getPrimaryDisplay();
}

/** Places and sizes the window. Collapsed picks the wake strip instead of the panel. */
function applyGeometry() {
  if (!win || win.isDestroyed()) return;
  const { bounds } = targetDisplay();
  const width = collapsed ? STRIP_W : PANEL_W;
  const height = collapsed ? STRIP_H : PANEL_H;
  win.setBounds({
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: bounds.y,
    width,
    height,
  });
  win.setAlwaysOnTop(true, "screen-saver");
}

function setIgnoring(ignore: boolean) {
  if (!win || win.isDestroyed() || ignoring === ignore) return;
  ignoring = ignore;
  win.setIgnoreMouseEvents(ignore);
}

/**
 * Emits `cursor` (window coordinates) at ~60 Hz while the island is visible, and
 * decides click-through in the same tick: the window only takes the mouse over
 * the island shape, so everything around it stays clickable.
 */
function tick() {
  if (!win || win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  const origin = win.getBounds();
  const x = point.x - origin.x;
  const y = point.y - origin.y;
  if (x === last.x && y === last.y) return;
  last = { x, y };

  const onIsland =
    rect.w > 0 &&
    x >= rect.x - HIT_MARGIN && x <= rect.x + rect.w + HIT_MARGIN &&
    y >= rect.y - HIT_MARGIN && y <= rect.y + rect.h + HIT_MARGIN;
  setIgnoring(!onIsland);

  emit("cursor", { x, y });
}

function setPolling(on: boolean) {
  if (on && !poll) {
    last = { x: Number.NaN, y: Number.NaN };
    poll = setInterval(tick, POLL_MS);
  } else if (!on && poll) {
    clearInterval(poll);
    poll = null;
  }
}

export function createIslandWindow(pref: "primary" | "cursor"): BrowserWindow {
  screenPref = pref;
  win = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Never steals focus from what you are doing; the chat field asks for it.
    focusable: false,
    title: "Poupou",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      // The island keeps animating while another app has the foreground.
      backgroundThrottling: false,
    },
  });
  win.setMenu(null);

  // Starts at full size so the launch greeting has room.
  collapsed = false;
  applyGeometry();

  win.once("ready-to-show", () => {
    win?.showInactive();
    applyGeometry();
    setPolling(true);
  });
  win.on("closed", () => {
    setPolling(false);
    win = null;
  });

  // Monitors get plugged in, unplugged, rearranged and rescaled, and an island
  // pinned to coordinates that no longer exist is an island nobody can reach.
  const moved = () => emit("screen-changed", null);
  screen.on("display-added", moved);
  screen.on("display-removed", moved);
  screen.on("display-metrics-changed", () => {
    applyGeometry();
    moved();
  });

  return win;
}

/**
 * Hidden island → shrink the window to the invisible wake strip and park the
 * cursor poll; anything else → full panel and 60 Hz polling.
 */
export function setCollapsed(value: boolean) {
  collapsed = value;
  applyGeometry();
  // The wake strip must always take the mouse, and a resize invalidates the flag.
  ignoring = true;
  setIgnoring(false);
  setPolling(!value);
}

export function setIslandRect(x: number, y: number, w: number, h: number) {
  rect = { x, y, w, h };
}

export function reposition() {
  applyGeometry();
}

export function setScreenPref(pref: "primary" | "cursor") {
  if (pref === screenPref) return;
  screenPref = pref;
  applyGeometry();
}

/** Temporarily allow activation so the chat field can be typed in. */
export function focusIsland(focused: boolean) {
  if (!win || win.isDestroyed()) return;
  win.setFocusable(focused);
  if (focused) {
    win.focus();
    win.webContents.focus();
  } else {
    win.blur();
  }
  // Toggling focusability rewrites the window styles; put the rest back.
  win.setSkipTaskbar(true);
  win.setAlwaysOnTop(true, "screen-saver");
}
