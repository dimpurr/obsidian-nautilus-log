/*
 * pomo.ts — the standalone count-up POMO control (M · 独立番茄钟).
 *
 * Upstream semantics (guide §Execution Layer): when no task CLOCK is running,
 * the panel-header stopwatch starts an independent count-up POMO.  It writes no
 * Roam blocks, does not affect Actual / Planned / Review / the spiral, and is
 * cleared whenever a task CLOCK starts — CLOCK always has priority.  Reaching
 * the threshold only marks the live text red (`.is-overdue`); the count keeps
 * going up and nothing stops, rings, or forces a break.
 *
 * 🔴 This is a count-UP timer, not a countdown.  Elapsed always derives from the
 *    absolute `startedAt` stored in the runtime snapshot — never from an
 *    accumulated counter — so navigating or refreshing recovers the same
 *    reading instead of resetting to zero.
 *
 * The control reuses the upstream topbar class names
 * (`nautilus-log-timing__elapsed` / `__pomodoro-label` / `__pomodoro-start` /
 * `__pomodoro-close`, `is-overdue`) so the styles that already exist in
 * styles.css apply without touching that file.
 *
 * Upstream baseline: 404KSG/roam-nautilus-log @ 7bf19a1d (timing-topbar).
 */

import type { ExecViewContext, TimingSnapshot } from './timing-contract';
import { createSvg } from './svg-util';

/** Vendored CJS engine, narrowed to the seams this module touches. */
interface PomoCore {
  standalonePomodoroElapsed(
    state: { startedAt?: number | string } | null | undefined,
    now?: number | Date,
  ): number;
  isStandalonePomodoroOverdue(
    state: { startedAt?: number | string } | null | undefined,
    now?: number | Date,
    thresholdMinutes?: number,
  ): boolean;
  formatElapsed(milliseconds: number): string;
  executionCopy(language: string): {
    actions?: { startPomodoro?: string; stopPomodoro?: string };
  };
}

const timingCore = require('./vendor/timing-core') as unknown as PomoCore;

/** Refresh cadence of the stopwatch display. */
const TICK_MS = 1000;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.setAttribute('class', cls);
  if (text !== undefined) node.textContent = text;
  return node;
}

function buttonEl(cls: string): HTMLButtonElement {
  const node = el('button', cls) as HTMLButtonElement;
  node.type = 'button';
  return node;
}

function stopwatchIcon(): Element {
  return createSvg(
    'svg',
    {
      width: '16',
      height: '16',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
    createSvg('circle', { cx: '12', cy: '13', r: '8' }),
    createSvg('path', { d: 'M12 9v4l2.5 2.5' }),
    createSvg('path', { d: 'M9 2h6' }),
    createSvg('path', { d: 'M12 2v3' }),
  );
}

function closeIcon(): Element {
  return createSvg(
    'svg',
    {
      width: '12',
      height: '12',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
    createSvg('line', { x1: '6', y1: '6', x2: '18', y2: '18' }),
    createSvg('line', { x1: '18', y1: '6', x2: '6', y2: '18' }),
  );
}

/**
 * Render the standalone POMO stopwatch into `container`.
 *
 * Idle (no task CLOCK, no active standalone POMO): an enabled stopwatch button.
 * Task CLOCK running: the same button, disabled — CLOCK always has priority.
 * Standalone POMO active: the count-up elapsed reading + POMO label + a stop
 * button; the reading turns `.is-overdue` at `ctx.pomodoroMinutes` and keeps
 * counting.
 *
 * Elapsed is recomputed from the snapshot's absolute `startedAt` on every tick
 * (wall-clock `Date.now()`), so the display is self-sufficient even when the
 * runtime is not publishing, and recovers after navigation.
 *
 * `destroy()` clears the tick interval, unsubscribes, and removes the control.
 */
export function renderPomoControl(
  container: HTMLElement,
  ctx: ExecViewContext,
): { destroy(): void } {
  let destroyed = false;
  let snapshot: TimingSnapshot = ctx.runtime.getSnapshot();

  /* Copy labels once (fall back to English if the copy table is unavailable). */
  let startLabel = 'Start standalone POMO';
  let stopLabel = 'Stop standalone POMO';
  try {
    const actions = timingCore.executionCopy(ctx.language)?.actions;
    if (actions?.startPomodoro) startLabel = actions.startPomodoro;
    if (actions?.stopPomodoro) stopLabel = actions.stopPomodoro;
  } catch {
    /* keep the English fallbacks */
  }

  /* ── DOM (built once, mutated in place) ─────────────────────────────── */

  const root = el('div', 'nautilus-log-timing__pomo');
  root.setAttribute('data-nl-role', 'standalone-pomodoro');

  const startBtn = buttonEl('nautilus-log-timing__icon-button nautilus-log-timing__pomodoro-start');
  startBtn.title = startLabel;
  startBtn.setAttribute('aria-label', startLabel);
  startBtn.append(stopwatchIcon());

  const running = el('span', 'nautilus-log-timing__trigger is-pomodoro is-active');
  running.setAttribute('role', 'timer');
  const elapsed = el('span', 'nautilus-log-timing__elapsed', '0:00');
  running.append(elapsed, el('span', 'nautilus-log-timing__pomodoro-label', 'POMO'));

  const closeBtn = buttonEl('nautilus-log-timing__pomodoro-close');
  closeBtn.title = stopLabel;
  closeBtn.setAttribute('aria-label', stopLabel);
  closeBtn.append(closeIcon());

  root.append(startBtn, running, closeBtn);
  container.appendChild(root);

  /* `hidden` on a styled element loses to its author `display` rule, so set
   *  both: the attribute for semantics, inline display for effect. */
  const setVisible = (node: HTMLElement, visible: boolean): void => {
    node.hidden = !visible;
    node.style.display = visible ? '' : 'none';
  };

  const render = (): void => {
    const focused = snapshot.activeWork?.focused;
    const standalone =
      (snapshot.standalonePomodoro as { startedAt?: number | string } | null | undefined) ?? null;
    const live = !focused && !!standalone;

    setVisible(startBtn, !live);
    setVisible(running, live);
    setVisible(closeBtn, live);

    if (live) {
      const now = Date.now();
      const seconds = timingCore.standalonePomodoroElapsed(standalone, now);
      const label = timingCore.formatElapsed(seconds * 1000);
      elapsed.textContent = label;
      running.classList.toggle(
        'is-overdue',
        timingCore.isStandalonePomodoroOverdue(standalone, now, ctx.pomodoroMinutes),
      );
      running.setAttribute('aria-label', `${label}, POMO`);
      running.title = `${label} · POMO`;
    } else {
      // Not counting: drop any stale overdue mark and reflect CLOCK priority.
      running.classList.remove('is-overdue');
      startBtn.disabled = !!focused;
    }
  };

  /* ── Wiring ─────────────────────────────────────────────────────────── */

  startBtn.addEventListener('click', () => {
    if (startBtn.disabled) return; // task CLOCK running — CLOCK always wins
    void ctx.runtime.startStandalonePomodoro();
  });

  closeBtn.addEventListener('click', () => {
    void ctx.runtime.stopStandalonePomodoro();
  });

  const unsubscribe = ctx.runtime.subscribe((next) => {
    snapshot = next;
    render();
  });
  render(); // covers runtimes whose subscribe does not synchronously deliver

  const timer = window.setInterval(() => {
    if (destroyed) return;
    render();
  }, TICK_MS);

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      window.clearInterval(timer);
      unsubscribe();
      root.remove();
    },
  };
}
