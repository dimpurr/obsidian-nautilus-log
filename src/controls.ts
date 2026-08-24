/*
 * controls.ts — the chart control button bar (Eye · Play · Collapse).
 *
 * UI + state only.  The actual effects — filtering completed slices, driving
 * the playback "current moment", hiding the chart body — are wired by the host
 * (main.ts / spiral.ts) from the `onChange` snapshots we emit:
 *
 *   · showDone  toggles the visibility of completed items;
 *   · collapsed is remembered per block via localStorage (upstream's
 *     read/write-collapsed-state), so a collapsed chart stays collapsed
 *     across reloads;
 *   · playback  is `null` when idle and `{ minute }` while replaying the day —
 *     we scan from workdayStartMinutes up to nowMinutes with a setInterval
 *     and stop automatically on arrival.  It never touches the Markdown.
 *
 * Icons are inline SVG (no third-party icon library, no obsidian import) so the
 * module runs unchanged under jsdom in tests.
 *
 * Upstream baseline: 404KSG/roam-nautilus-log @ 7bf19a1d.
 */

import * as logCoreModule from "./vendor/log-core";
import type { NautilusSettings } from "./contract";

/* ------------------------------------------------------------------ */
/* Vendored engine, narrowed to the seam this module touches.          */
/* ------------------------------------------------------------------ */

interface ControlsCore {
  uiCopy(language: string): Record<string, Record<string, string>>;
}

const core = (logCoreModule as unknown) as ControlsCore;

export interface ChartControlState {
  showDone: boolean;
  collapsed: boolean;
  playback: null | { minute: number };   // null = not replaying
}

export interface ChartControlHandlers {
  onChange(next: ChartControlState): void;
}

/* Playback pacing: the whole remaining day replays in about a minute. */
const PLAYBACK_TICK_MS = 1000;
const PLAYBACK_TICK_COUNT = 60;

/* uiCopy has no label for the "playing" state of the play button (upstream
 * disables the button instead of re-labelling it).  We complement it here
 * rather than touching the vendored copy table. */
const STOP_PLAYBACK_LABEL: Record<string, string> = {
  en: "Stop playback",
  zh: "停止回放",
};

const SVG_NS = "http://www.w3.org/2000/svg";

function svgIcon(inner: string, size = 16): Element {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = inner;
  return svg;
}

const ICON_EYE =
  '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>' +
  '<circle cx="12" cy="12" r="3"></circle>';
const ICON_EYE_OFF =
  '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 ' +
  '0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1 ' +
  '-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>' +
  '<line x1="1" y1="1" x2="23" y2="23"></line>';
const ICON_PLAY = '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
const ICON_STOP = '<rect x="5" y="5" width="14" height="14" rx="2"></rect>';
/* Expanded -> chevron up ("click to collapse"); collapsed -> chevron down
 * ("click to expand").  Mirrors upstream collapse-button. */
const ICON_COLLAPSE =
  '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect>' +
  '<path d="M3 9h18"></path>' +
  '<path d="m9 16 3-3 3 3"></path>';
const ICON_EXPAND =
  '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect>' +
  '<path d="M3 9h18"></path>' +
  '<path d="m9 13 3 3 3-3"></path>';

/* ------------------------------------------------------------------ */
/* localStorage persistence (guarded — storage can throw in some        */
/* Obsidian webviews and must never take the whole chart down).        */
/* ------------------------------------------------------------------ */

function readCollapsed(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

function writeCollapsed(storageKey: string, value: boolean): void {
  try {
    window.localStorage.setItem(storageKey, String(value));
  } catch {
    // Storage unavailable — collapse still applies for this session.
  }
}

/* ------------------------------------------------------------------ */
/* Small DOM helpers.                                                  */
/* ------------------------------------------------------------------ */

function copyLabel(
  copy: Record<string, string> | undefined,
  key: string,
  fallback: string,
): string {
  const value = copy && copy[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function setButtonA11y(
  btn: HTMLButtonElement,
  label: string,
  pressed?: boolean,
): void {
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  if (pressed === undefined) btn.removeAttribute("aria-pressed");
  else btn.setAttribute("aria-pressed", String(pressed));
}

function clearChildren(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ------------------------------------------------------------------ */
/* Public entry point.                                                 */
/* ------------------------------------------------------------------ */

/**
 * Render the Eye / Play / Collapse button bar into `container`.
 *
 * `state` seeds the component; `handlers.onChange` receives a full snapshot
 * after every interaction (and once at render if the persisted collapsed value
 * differs from the passed-in one).  `storageKey` is the exact localStorage key
 * used to remember `collapsed` per block (e.g. `"nautilus-log:collapsed:v1:<uid>"`).
 *
 * Returns `{ destroy() }` — must be called on teardown; it clears any running
 * playback interval and removes the button bar from the container.
 */
export function renderChartControls(
  container: HTMLElement,
  state: ChartControlState,
  handlers: ChartControlHandlers,
  settings: NautilusSettings,
  opts: { workdayStartMinutes: number; workdayEndMinutes: number; nowMinutes: number },
  storageKey: string,
): { destroy(): void } {
  const controlsCopy = core.uiCopy(settings.language).controls;
  const stopLabel = STOP_PLAYBACK_LABEL[settings.language] ?? STOP_PLAYBACK_LABEL.en;

  // Local working state.  Persisted collapse wins over the passed-in value,
  // mirroring upstream where read-collapsed-state seeds the atom.
  const initialCollapsed = !!state.collapsed;
  const persistedCollapsed = readCollapsed(storageKey);
  const needsCollapseSync = persistedCollapsed && !initialCollapsed;

  let current: ChartControlState = {
    showDone: !!state.showDone,
    collapsed: needsCollapseSync ? true : initialCollapsed,
    playback: state.playback === null ? null : { minute: state.playback.minute },
  };

  /* ------------------------------------------------------------------ */
  /* Playback.                                                           */
  /* ------------------------------------------------------------------ */

  let playbackTimer: ReturnType<typeof setInterval> | null = null;

  function startPlayback(): void {
    if (playbackTimer !== null) return;
    // Playback replays the visible day up to "now"; never past the chart end.
    const end = Math.max(
      opts.workdayStartMinutes,
      Math.min(opts.nowMinutes, opts.workdayEndMinutes),
    );
    if (end <= opts.workdayStartMinutes) return;   // nothing to replay
    const step = Math.max(
      1,
      Math.round((end - opts.workdayStartMinutes) / PLAYBACK_TICK_COUNT),
    );
    let minute = opts.workdayStartMinutes;

    current.playback = { minute };
    handlers.onChange({ ...current });
    updatePlay();

    playbackTimer = setInterval(() => {
      minute = Math.min(end, minute + step);
      current.playback = { minute };
      handlers.onChange({ ...current });
      if (minute >= end) stopPlayback();
    }, PLAYBACK_TICK_MS);
  }

  function stopPlayback(): void {
    if (playbackTimer !== null) {
      clearInterval(playbackTimer);
      playbackTimer = null;
    }
    if (current.playback !== null) {
      current.playback = null;
      handlers.onChange({ ...current });
    }
    updatePlay();
  }

  /* ------------------------------------------------------------------ */
  /* Buttons.                                                            */
  /* ------------------------------------------------------------------ */

  const root = document.createElement("div");
  root.className = "nautilus-log-controls-top";

  const eyeBtn = document.createElement("button");
  eyeBtn.type = "button";
  eyeBtn.className = "nautilus-log-toggle-btn";
  eyeBtn.addEventListener("click", () => {
    current.showDone = !current.showDone;
    handlers.onChange({ ...current });
    updateEye();
  });

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "nautilus-log-toggle-btn";
  playBtn.addEventListener("click", () => {
    if (current.playback === null) startPlayback();
    else stopPlayback();
  });

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.className = "nautilus-log-toggle-btn nautilus-log-collapse-btn";
  collapseBtn.addEventListener("click", () => {
    current.collapsed = !current.collapsed;
    writeCollapsed(storageKey, current.collapsed);
    handlers.onChange({ ...current });
    updateCollapse();
  });

  function updateEye(): void {
    const label = copyLabel(
      controlsCopy,
      current.showDone ? "hideDone" : "showDone",
      current.showDone ? "Hide completed items" : "Show completed items",
    );
    setButtonA11y(eyeBtn, label, current.showDone);
    eyeBtn.classList.toggle("nautilus-log-toggle-btn--active", current.showDone);
    clearChildren(eyeBtn);
    eyeBtn.appendChild(svgIcon(current.showDone ? ICON_EYE : ICON_EYE_OFF));
  }

  function updatePlay(): void {
    const playing = current.playback !== null;
    setButtonA11y(
      playBtn,
      playing ? stopLabel : copyLabel(controlsCopy, "playback", "Play back the day"),
      playing,
    );
    playBtn.classList.toggle("nautilus-log-playback-active", playing);
    clearChildren(playBtn);
    playBtn.appendChild(svgIcon(playing ? ICON_STOP : ICON_PLAY));
  }

  function updateCollapse(): void {
    const label = copyLabel(
      controlsCopy,
      current.collapsed ? "expand" : "collapse",
      current.collapsed ? "Expand Nautilus Log" : "Collapse Nautilus Log",
    );
    setButtonA11y(collapseBtn, label);
    collapseBtn.setAttribute("aria-expanded", String(!current.collapsed));
    clearChildren(collapseBtn);
    collapseBtn.appendChild(svgIcon(current.collapsed ? ICON_EXPAND : ICON_COLLAPSE, 18));
  }

  updateEye();
  updatePlay();
  updateCollapse();

  // Upstream order: Eye, Play, Collapse.
  root.appendChild(eyeBtn);
  root.appendChild(playBtn);
  root.appendChild(collapseBtn);
  container.appendChild(root);

  // If we hydrated a persisted collapse that the caller didn't know about,
  // tell it now so the chart body renders collapsed immediately.
  if (needsCollapseSync) {
    handlers.onChange({ ...current });
  }

  return {
    destroy(): void {
      if (playbackTimer !== null) {
        clearInterval(playbackTimer);
        playbackTimer = null;
      }
      if (root.parentNode === container) {
        container.removeChild(root);
      }
    },
  };
}
