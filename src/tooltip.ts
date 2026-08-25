/*
 * 悬停提示。几何全部来自 vendor 的 log-core：
 *   radialTooltipGeometry  -> 切片在盘上的锚点（含方向向量）
 *   placeFloatingTooltip   -> 视口内定位，靠边自动翻面
 * 这里只负责 DOM 与事件，一行几何都不自己算。
 *
 * 键盘可达：切片本身已带 tabindex/role/aria-label（渲染器给的），
 * 所以 focus/blur 与 mouse 走同一套路径。
 */

const core = require('./vendor/log-core') as {
  radialTooltipGeometry(a: {
    startMinutes: number; endMinutes: number;
    centerX: number; centerY: number; radius: number;
  }): { center: { x: number; y: number }; direction: { x: number; y: number } } | null;
  placeFloatingTooltip(a: {
    anchorX: number; anchorY: number;
    tooltipWidth: number; tooltipHeight: number;
    viewportWidth: number; viewportHeight: number;
    /** P1-9②：径向偏好方向。不传时引擎默认 'right'（vendor/log-core.js:1389），
     *  左半盘的提示于是全部朝右弹、盖住盘面。 */
    preferred?: string;
    margin?: number;
    gap?: number;
  }): { x: number; y: number; placement: string } | null;
};

/* P1-9③：SVG 用户坐标 -> 屏幕坐标。上游 component.cljs:436-459 的
 * `svg-screen-point`。<svg> 是 width:100% + viewBox，缩放几乎从不等于 1，
 * 直接把用户坐标当像素加到 host 左上角会系统性偏移（图越小偏得越多）。 */
interface CtmSvg {
  getScreenCTM?(): unknown;
  createSVGPoint?(): { x: number; y: number; matrixTransform(m: unknown): { x: number; y: number } };
}

function svgScreenPoint(svg: CtmSvg | null, pt: { x: number; y: number }):
  { x: number; y: number } | null {
  try {
    const matrix = svg?.getScreenCTM?.();
    const point = svg?.createSVGPoint?.();
    if (!matrix || !point) return null;
    point.x = pt.x;
    point.y = pt.y;
    const screen = point.matrixTransform(matrix);
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return null;
    return { x: screen.x, y: screen.y };
  } catch {
    return null;
  }
}

/** 上游 hover-anchor（component.cljs:447-459）：方向向量相对圆心的主轴决定偏好边。 */
function preferredSide(dx: number, dy: number): string {
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "top" : "bottom";
}

export interface TooltipTarget {
  el: Element;
  startMinutes: number;
  endMinutes: number;
  /** 已渲染好的行（标题 / 时间区间 / 时长…），逐行显示 */
  lines: string[];
}

export interface TooltipController {
  attach(targets: TooltipTarget[], geo: { centerX: number; centerY: number; radius: number }): void;
  destroy(): void;
}

export function createTooltip(host: HTMLElement): TooltipController {
  const doc = host.ownerDocument;
  const tip = doc.createElement('div');
  tip.className = 'nautilus-log-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.style.display = 'none';
  host.appendChild(tip);

  // 每个目标注册的监听都记下来，destroy 时逐个摘掉 —— 否则重渲染会累积泄漏。
  let bound: { el: Element; type: string; fn: EventListener }[] = [];

  function hide(): void { tip.style.display = 'none'; }

  function show(t: TooltipTarget, geo: { centerX: number; centerY: number; radius: number }): void {
    tip.empty?.();
    while (tip.firstChild) tip.removeChild(tip.firstChild);
    for (const line of t.lines) {
      const row = doc.createElement('div');
      row.className = 'nautilus-log-tooltip-line';
      row.textContent = line;
      tip.appendChild(row);
    }
    // 先显示再量尺寸，否则 offsetWidth 是 0，定位会全部挤到左上角。
    tip.style.display = 'block';
    tip.style.visibility = 'hidden';

    const anchor = core.radialTooltipGeometry({
      startMinutes: t.startMinutes, endMinutes: t.endMinutes,
      centerX: geo.centerX, centerY: geo.centerY, radius: geo.radius,
    });
    if (!anchor) { hide(); return; }

    const hostBox = host.getBoundingClientRect();

    // P1-9③：优先走 getScreenCTM 换算；拿不到（jsdom / 未挂载）再退回
    // 「viewBox 缩放 = 1」的旧假设，至少不比以前差。
    const svg = (t.el.closest?.("svg.nautilus-log-svg") ?? null) as CtmSvg | null;
    const centerScreen = svgScreenPoint(svg, anchor.center);
    const directionScreen = svgScreenPoint(svg, anchor.direction);
    const exact = centerScreen !== null && directionScreen !== null;

    const anchorX = exact
      ? (directionScreen as { x: number }).x
      : hostBox.left + anchor.direction.x;
    const anchorY = exact
      ? (directionScreen as { y: number }).y
      : hostBox.top + anchor.direction.y;
    const from = exact ? (centerScreen as { x: number; y: number }) : anchor.center;
    const to = exact ? (directionScreen as { x: number; y: number }) : anchor.direction;

    const placed = core.placeFloatingTooltip({
      anchorX,
      anchorY,
      tooltipWidth: tip.offsetWidth,
      tooltipHeight: tip.offsetHeight,
      viewportWidth: doc.defaultView?.innerWidth || 1200,
      viewportHeight: doc.defaultView?.innerHeight || 800,
      preferred: preferredSide(to.x - from.x, to.y - from.y),   // P1-9②
      margin: 12,   // 上游 component.cljs:477-478 的显式取值
      gap: 10,
    });
    if (!placed) { hide(); return; }

    tip.style.left = `${placed.x - hostBox.left}px`;
    tip.style.top = `${placed.y - hostBox.top}px`;
    tip.dataset.placement = placed.placement;
    tip.style.visibility = 'visible';
  }

  return {
    attach(targets, geo) {
      for (const b of bound) b.el.removeEventListener(b.type, b.fn);
      bound = [];
      for (const t of targets) {
        const enter: EventListener = () => show(t, geo);
        const leave: EventListener = () => hide();
        for (const [type, fn] of [
          ['mouseenter', enter], ['focus', enter],
          ['mouseleave', leave], ['blur', leave],
        ] as [string, EventListener][]) {
          t.el.addEventListener(type, fn);
          bound.push({ el: t.el, type, fn });
        }
      }
    },
    destroy() {
      for (const b of bound) b.el.removeEventListener(b.type, b.fn);
      bound = [];
      tip.remove();
    },
  };
}
