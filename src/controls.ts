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
 *     推进由【宿主】驱动（见下方 startPlayback 注释），本组件不持有定时器
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
 * rather than touching the vendored copy table.
 *
 * 认证审计 C2-043（有意偏离，待登记台账）：上游播放中把按钮置 `:disabled`
 * 且图标不变，一旦开播只能等它跑完；本移植换成可点的停止键。上游的回放是
 * 固定 6s 的一次性动画，而本移植的时钟归宿主、步长随窗口长度变化（见下方
 * startPlayback 的注释），跑起来可能明显更久 —— 没有中止手段是不可接受的。 */
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

/**
 * 认证审计 C2-054：上游的键是 `"nautilus-log:collapsed:v1:" + block-uid`
 * （`component.cljs:1417-1418`）。本移植的调用方传的是裸的
 * `"<path>.md:<lineOffset>"` —— vault 级的 localStorage 里于是躺着一个毫无
 * 命名空间的键，既撞得上别的插件，也没有版本位可供将来迁移。
 *
 * 命名空间在**这里**补，而不是要求每个调用方自己拼：调用方只知道「这是哪
 * 一块」，键的格式与版本位是本组件的实现细节（本文件的 doc 一直是这么写
 * 的，只有调用方没照做）。已经带前缀的键原样通过 —— 幂等，老键不迁移。
 */
const COLLAPSED_STORAGE_PREFIX = "nautilus-log:collapsed:v1:";

export function collapsedStorageKey(blockKey: string): string {
  return blockKey.startsWith(COLLAPSED_STORAGE_PREFIX)
    ? blockKey
    : `${COLLAPSED_STORAGE_PREFIX}${blockKey}`;
}

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
 * differs from the passed-in one).  `blockKey` identifies the block whose
 * collapsed state is remembered; the localStorage namespace/version prefix is
 * added here (`collapsedStorageKey`, 认证审计 C2-054), so callers pass a bare
 * block identity such as `"<path>.md:<lineOffset>"`.
 *
 * Mount point mirrors upstream `component.cljs:1874-1881`: expanded charts put
 * the bar in the header's actions column (before the legend); collapsed charts
 * put it straight into the block root, which is also what makes
 * `.nautilus-log-collapsed .nautilus-log-controls-top` position correctly.
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
  blockKey: string,
): { destroy(): void } {
  const controlsCopy = core.uiCopy(settings.language).controls;
  const stopLabel = STOP_PLAYBACK_LABEL[settings.language] ?? STOP_PLAYBACK_LABEL.en;
  const storageKey = collapsedStorageKey(blockKey);   // 认证审计 C2-054

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


  // 🔴 播放时钟【不归本组件所有】。宿主（main.ts 的 view）每次状态变化都会
  //    整块重渲染 => 本组件被 destroy 后重建。若在这里 setInterval，会出现：
  //    onChange -> 宿主重渲染 -> destroy 本实例 -> 之后才 setInterval
  //    => 定时器建在已销毁的实例上，clearInterval 永远轮不到它，
  //       孤儿定时器不停把 playback 复活，表现就是「停不下来」。
  //    本组件只上报【意图】，推进由宿主做（宿主本来就有渲染时钟）。
  //  认证审计 C2-044（有意偏离，待登记台账）：上游 6000ms 内从 workdayStart
  //    线性扫到 **workdayEnd**；本移植扫到 **min(此刻, workdayEnd)**。理由是
  //    本移植的容量与楔形都按 dayState 从「此刻」切分，回放越过此刻只会重复
  //    播放一段还没发生的计划；到此刻为止才是「重播今天」。
  function startPlayback(): void {
    const end = Math.max(
      opts.workdayStartMinutes,
      Math.min(opts.nowMinutes, opts.workdayEndMinutes),
    );
    if (end <= opts.workdayStartMinutes) return;   // 没有可回放的区间
    current.playback = { minute: opts.workdayStartMinutes };
    handlers.onChange({ ...current });
    updatePlay();
  }

  function stopPlayback(): void {
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

  /* ------------------------------------------------------------------ */
  /* 骨架同步（认证审计 C2-023 / C2-024 / C2-057）                        */
  /* ------------------------------------------------------------------ */

  /** 被本组件临时藏起来的兄弟节点（折叠态）。展开时逐一还原。 */
  const hidden: HTMLElement[] = [];

  function showHiddenSiblings(): void {
    while (hidden.length > 0) {
      const node = hidden.pop();
      if (node) node.style.display = node.dataset.nlPrevDisplay || "";
      if (node) delete node.dataset.nlPrevDisplay;
    }
  }

  /**
   * 认证审计 C2-023：上游把这条按钮栏放在 `header-actions` 列里（图例之前）。
   * 本移植原先把它 append 成块根的兄弟节点 —— 紧凑宽度下
   * `styles.css` 的 `@container` 规则会把 `header-copy` 与图例都藏掉，于是
   * header 塌成一条 32px 空条，按钮却掉到它下面。
   *
   * 认证审计 C2-057：折叠时上游只渲染这条按钮栏、且它是块根的直接子节点，
   * 靠 `.nautilus-log-collapsed .nautilus-log-controls-top{position:absolute}`
   * 浮到块上方。所以折叠态必须**离开** header-actions，否则会跟着 header
   * 一起被藏掉。
   */
  function placeControls(): void {
    const actions = current.collapsed
      ? null
      : (container.querySelector(".nautilus-log-header-actions") as HTMLElement | null);
    const target: HTMLElement = actions || container;
    if (root.parentNode === target) return;
    if (actions) actions.insertBefore(root, actions.firstChild);   // 上游顺序：controls 在图例之前
    else container.appendChild(root);
  }

  /**
   * 认证审计 C2-024 / C2-057：折叠后块根拿 `nautilus-log-collapsed`，并且
   * 除了按钮栏之外**什么都不显示**（上游 `component.cljs:1874-1875` 是压根
   * 不渲染）。
   *
   * ⚠️ 有意偏离：上游「不渲染」，本移植「渲染后藏起来」。原因是挂载顺序归
   * 宿主（`main.ts` 在知道 collapsed 之前就已经画好了 header 与紧凑概览），
   * 而 `.nautilus-log-collapsed` 是 `height:0; overflow:visible` —— 若把
   * header 留着，它会整段溢出压在下一段正文上。见报告。
   */
  function syncCollapsedShell(): void {
    container.classList?.toggle("nautilus-log-collapsed", current.collapsed);
    showHiddenSiblings();
    if (!current.collapsed) return;
    // 🔴 不用 `instanceof HTMLElement` —— 测试里只往 globalThis 注入了
    //    window/document，构造器本身不在全局，会直接 ReferenceError。
    for (const child of Array.from(container.children) as HTMLElement[]) {
      if (child === root || !child.style || !child.dataset) continue;
      child.dataset.nlPrevDisplay = child.style.display;
      child.style.display = "none";
      hidden.push(child);
    }
  }

  function updateCollapse(): void {
    const label = copyLabel(
      controlsCopy,
      current.collapsed ? "expand" : "collapse",
      current.collapsed ? "Expand Nautilus Logger" : "Collapse Nautilus Logger",
    );
    setButtonA11y(collapseBtn, label);
    collapseBtn.setAttribute("aria-expanded", String(!current.collapsed));
    clearChildren(collapseBtn);
    collapseBtn.appendChild(svgIcon(current.collapsed ? ICON_EXPAND : ICON_COLLAPSE, 18));
    placeControls();
    syncCollapsedShell();
  }

  updateEye();
  updatePlay();

  // Upstream order: Eye, Play, Collapse.
  root.appendChild(eyeBtn);
  root.appendChild(playBtn);
  root.appendChild(collapseBtn);
  updateCollapse();   // 内含挂载点选择 + 折叠骨架同步，必须在按钮装配之后

  // If we hydrated a persisted collapse that the caller didn't know about,
  // tell it now so the chart body renders collapsed immediately.
  if (needsCollapseSync) {
    handlers.onChange({ ...current });
  }

  return {
    destroy(): void {
      // 🔴 挂载点可能是 header-actions（C2-023），不再恒等于 container。
      root.parentNode?.removeChild(root);
      container.classList?.remove("nautilus-log-collapsed");
      showHiddenSiblings();
    },
  };
}
