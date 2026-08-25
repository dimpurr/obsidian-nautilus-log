/*
 * Obsidian 数据层适配器 —— 上游 timing-roam.js 的对应物。
 *
 * `src/vendor/timing-runtime.js` 是零 Roam 耦合的执行层状态机，它 import 了
 * timing-roam.js 的 17 个函数。本文件在 Obsidian 里实现同一接口，让整套 CLOCK
 * 时间追踪（状态机 / 竞态 / 番茄钟）原样跑起来，不用重写。
 *
 * ── uid 形态 ────────────────────────────────────────────────────────────
 * Roam 用 `:block/uid`；Obsidian 没有，我们沿用 src/contract.ts 的 LineId：
 *   "<vault 相对路径>:<0 起行号>"  例如 "Journal/2026-08-24.md:12"
 * 🔴 行号会随编辑漂移 —— 写回前一律用【行内容】复核，不信任行号。
 *
 * ── 读写通道（写回是本项目唯一会改用户文件的代码，坏了会损坏笔记）──────
 * · 目标文件正被编辑器打开  ⇒ 走 Editor API（setLine / replaceRange），
 *   与用户的在编辑改动合并，绝不整篇覆盖。
 * · 否则                    ⇒ 走 vault.process（原子读改写）。
 * 🔴 每次写回都先做内容校验：目标行仍与预期一致才落笔，校验不过就抛错放弃，
 *   绝不猜着写。上游 Tasks 插件注释直指同款风险：
 *   "Obsidian would write after us and overwrite our change."
 *
 * ── 任务状态桥接 ────────────────────────────────────────────────────────
 * timing-core 的 taskStatus 只认 Roam 语法 `{{TODO}}`/`{{DONE}}`；而 Obsidian
 * 笔记里任务是 `- [ ]`/`- [x]`（实测 taskStatus('- [ ] …') === null）。vendored
 * 运行时直接拿 readBlockString 的结果调 taskStatus，所以本适配器的【读】把
 * `- [ ]` 规范化为 `{{TODO}}`、`- [x]` 规范化为 `{{DONE}}`；【写】则始终操作
 * 磁盘上的【原始行】，写回去的仍是 `- [x]`，不把 Roam 语法写进 Obsidian 笔记。
 */

import type { App, TFile, Editor } from 'obsidian';
import { extractPlanBody } from './blockconfig';

/** timing-core 里我们用到的函数的最小签名。vendored CJS，无声明文件，
 *  这里手动钉住接口（照类型猜返回值在本项目已栽过两次跟头）。 */
interface TimingCore {
  parseClockLine(string: string): {
    start: Date; end: Date | null; running: boolean; minutes: number | null;
  } | null;
  formatClockLine(start: Date, end?: Date | null): string;
  taskStatus(string: string): string | null;
  taskTitle(string: string): string;
  taskProgress(string: string): number;
  parseTimeRangeMinutes(string: string): { start: number; end: number; text: string; warning: string; warningCode: string } | null;
  projectPlan(rows: PlanRow[], planUid: string, fallbackMinutes?: number): unknown[];
  projectReviewTasks(rows: PlanRow[], planUid: string, fallbackMinutes?: number): unknown[];
  projectFixedEvents(rows: PlanRow[], planUid: string): unknown[];
  isNautilusComponent(string: string): boolean;
}

const timingCore = require('./vendor/timing-core') as unknown as TimingCore;

/** 一个 CLOCK 条目。字段名与上游 normalizeEntryRows 一致。 */
export interface TimingEntry {
  start: Date;
  end: Date | null;
  running: boolean;
  minutes: number | null;
  clockUid: string;
  taskUid: string;
  taskString: string;
  title: string;
  status: string | null;
  pageTitle: string;
}

/** readPrimaryPlan 返回的计划快照。字段名与上游一致。 */
export interface PrimaryPlanSnapshot {
  pageTitle: string;
  pageUid: string | null;
  plan: { uid: string; string: string; order: number; parentUid: string | null } | null;
  rows: PlanRow[];
  tasks: unknown[];
  reviewTasks: unknown[];
  fixedEvents: unknown[];
}

interface PlanRow {
  uid: string;
  string: string;
  order: number;
  parentUid: string;
}

/** 主会话（main.ts）注入的最小宿主。app 必需；notify/dailyNotePath 可选覆盖，
 *  便于测试注入 fake 与让主会话把 showToast 接成 `new Notice(...)`。 */
export interface TimingHost {
  app: App;
  /** showToast 的落点。主会话接成 `(msg) => new Notice(msg)`。 */
  notify?: (message: string, intent?: 'warning' | 'danger') => void;
  /** 今日 Daily Note 的解析。缺省用 Obsidian daily-notes 插件 + 文件名兜底。 */
  dailyNotePath?: (date: Date) => string | null;
}

let host: TimingHost | null = null;
let metadataListener: ((file: TFile) => void) | null = null;

/** 同步读的内容缓存。Obsidian 的 vault 全是异步 API，而运行时在 refresh()
 *  里同步调 readPrimaryPlan / readAllEntries / readBlockString —— 只能靠缓存。
 *  init 时预热全部 markdown，并在每次 vault 文件改动 / 每次写回后刷新。 */
const contentCache = new Map<string, string>();

function getApp(): App {
  if (!host?.app) throw new Error('Nautilus Log timing adapter is not initialised. Call initTimingObsidian() first.');
  return host.app;
}

/** duck-typing 判文件 —— TFile 是 type-only import，运行时不能 `instanceof`。 */
function isFileLike(f: unknown): f is { path: string } {
  return !!f && typeof (f as { path?: unknown }).path === 'string';
}

async function primeFile(path: string): Promise<string | null> {
  const a = getApp();
  const f = a.vault.getAbstractFileByPath(path);
  if (!isFileLike(f)) return null;
  try {
    const text = await a.vault.cachedRead(f as TFile);
    contentCache.set(path, text);
    return text;
  } catch {
    return null;
  }
}

export async function primeTimingCache(): Promise<void> {
  const a = getApp();
  const files = a.vault.getMarkdownFiles();
  await Promise.all((files || []).map((f) => primeFile(f.path)));
}

/** 主会话在创建运行时【之前】调用。预热缓存并监听文件改动。 */
export function initTimingObsidian(next: TimingHost): void {
  host = next;
  const mc = next.app.metadataCache;
  if (metadataListener && mc?.off) {
    try { mc.off('changed', metadataListener); } catch { /* ignore */ }
  }
  metadataListener = (file) => { if (isFileLike(file)) void primeFile(file.path); };
  if (mc?.on) {
    try { mc.on('changed', metadataListener); } catch { /* ignore */ }
  }
  // 🔴 预热【必须】等到 onLayoutReady。插件 onload 时 vault 还没索引完，
  //    getMarkdownFiles() 返回空数组 => 缓存永远是 0 条，而同步读又只认缓存，
  //    执行层于是永远报「今天没有 Nautilus Log」。实测踩到，别改回 onload 直调。
  const ws = next.app.workspace as unknown as { onLayoutReady?: (cb: () => void) => void };
  if (typeof ws?.onLayoutReady === 'function') ws.onLayoutReady(() => { void primeTimingCache(); });
  else void primeTimingCache();
}

export function disposeTimingObsidian(): void {
  const mc = host?.app?.metadataCache;
  if (metadataListener && mc?.off) {
    try { mc.off('changed', metadataListener); } catch { /* ignore */ }
  }
  metadataListener = null;
  host = null;
}

/* ─────────────────────────── 行级小工具 ─────────────────────────── */

function splitUid(uid: string): { path: string; line: number } | null {
  if (typeof uid !== 'string' || !uid) return null;
  const idx = uid.lastIndexOf(':');
  if (idx <= 0) return null;
  const path = uid.slice(0, idx);
  const line = Number(uid.slice(idx + 1));
  if (!path || !Number.isInteger(line) || line < 0) return null;
  return { path, line };
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n += 1;
  return n;
}

function toMs(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 任务状态桥接：把 Obsidian `- [ ]`/`- [x]` 规范化为 timing-core 认识的
 *  `{{TODO}}`/`{{DONE}}`；非 checkbox 行剥掉列表标记后原样返回。 */
function normalizeTaskString(raw: string): string {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  const m = /^([-*+])\s+\[(.)\]\s*(.*)$/.exec(trimmed);
  if (m) {
    const checked = /[xX]/.test(m[2]);
    return `${checked ? '{{DONE}}' : '{{TODO}}'} ${m[3]}`.replace(/\s+$/, '');
  }
  return trimmed.replace(/^[-*+]\s+/, '');
}

function isDrawerLine(trimmed: string): boolean {
  const noMarker = trimmed.replace(/^[-*+]\s+/, '');
  return /^:?LOGBOOK:{1,2}$/i.test(noMarker);
}

/** 剥掉列表标记后交给 timing-core 解析 —— CLOCK 解析一律走 parseClockLine。 */
function parseClockLineFromLine(line: string): TimingCore['parseClockLine'] extends (s: string) => infer R ? R : never {
  if (typeof line !== 'string') return null;
  const noMarker = line.trim().replace(/^[-*+]\s+/, '');
  return timingCore.parseClockLine(noMarker);
}

/** 保留原 CLOCK 行的缩进与列表标记前缀。formatClockLine 只产出裸
 *  `CLOCK: …`，写回时必须补回前缀，否则会破坏文件里的层级。 */
/** 取 CLOCK 行的缩进 + 列表标记，改写时原样保留。
 *  🔴 这里的 `([-*+]\s+)` 必须是【捕获组】—— 写成非捕获组 `(?:...)` 时 m[2]
 *     恒为 undefined，列表标记会被静默吃掉：`- CLOCK: …` 变成 `CLOCK: …`，
 *     Markdown 列表结构随之破坏。（2026-08-24 实测踩到。） */
function clockPrefix(rawLine: string): string {
  const m = /^(\s*)([-*+]\s+)?/.exec(rawLine);
  return (m ? m[1] : '') + (m && m[2] ? m[2] : '');
}

function cachedLines(path: string): string[] | null {
  const text = contentCache.get(path);
  // 未命中就【顺手补一次】。同步调用这里拿不到结果，但下一次 refresh（tick 或
  //    任何写回）就能命中 —— 好过一直空着等用户去编辑那个文件。
  if (typeof text !== 'string') { void primeFile(path); return null; }
  return text.split('\n');
}

/* ─────────────────────────── 扫描：把 LOGBOOK 抽屉里的 CLOCK
 *                             聚合成 TimingEntry ─────────────────────────── */

function buildEntry(
  parsed: NonNullable<ReturnType<TimingCore['parseClockLine']>>,
  clockUid: string,
  taskUid: string,
  taskStringRaw: string,
  pageTitle: string,
): TimingEntry {
  const taskString = normalizeTaskString(taskStringRaw);
  return {
    ...parsed,
    clockUid,
    taskUid,
    taskString,
    title: timingCore.taskTitle(taskString),
    status: timingCore.taskStatus(taskString),
    pageTitle,
  };
}

/** 找到 LOGBOOK 抽屉的父任务行：它前面最近的一行【缩进更小】的非空行。 */
function findParentTaskIndex(lines: string[], drawerIndex: number, drawerIndent: number): number {
  for (let j = drawerIndex - 1; j >= 0; j -= 1) {
    if (!lines[j].trim()) continue;
    if (leadingSpaces(lines[j]) < drawerIndent) return j;
  }
  return -1;
}

/** 扫描单文件，收集其中所有 LOGBOOK 抽屉下的 CLOCK 条目（按 start 降序）。 */
function scanFile(path: string, lines: string[]): TimingEntry[] {
  const entries: TimingEntry[] = [];
  let activeDrawer: { indent: number; taskIndex: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = leadingSpaces(line);
    const trimmed = line.trim();
    // 离开当前抽屉的子树（缩进不再大于抽屉）。
    if (activeDrawer && indent <= activeDrawer.indent) activeDrawer = null;
    if (isDrawerLine(trimmed)) {
      activeDrawer = { indent, taskIndex: findParentTaskIndex(lines, i, indent) };
      continue;
    }
    const parsed = parseClockLineFromLine(line);
    if (parsed && activeDrawer && indent > activeDrawer.indent) {
      const taskIndex = activeDrawer.taskIndex;
      entries.push(buildEntry(
        parsed,
        `${path}:${i}`,
        `${path}:${taskIndex}`,
        taskIndex >= 0 ? lines[taskIndex] : '',
        path,
      ));
    }
  }
  return entries.sort((a, b) => b.start.getTime() - a.start.getTime());
}

/** 🔴 CLOCK 行只精确到【分钟】，而调用方给的 Date 带秒和毫秒。
 *  严格相等比较永远不成立 => Clock In 写入成功却"确认失败"，真机上必然报
 *  "Clock In could not be confirmed."。比较前一律截到分钟。 */
function toMinuteMs(ms: number | null): number | null {
  return ms === null ? null : Math.floor(ms / 60000) * 60000;
}

function findClockIndexByStart(lines: string[], startMs: number | null, running: boolean | undefined): number {
  const target = toMinuteMs(startMs);
  if (target === null) return -1;
  for (let i = 0; i < lines.length; i += 1) {
    const p = parseClockLineFromLine(lines[i]);
    if (!p || toMinuteMs(toMs(p.start)) !== target) continue;
    if (running === undefined || p.running === running) return i;
  }
  return -1;
}

/* ─────────────────────────── 读（4） ─────────────────────────── */

/** 全文扫描所有 markdown，返回所有 CLOCK 条目（按 start 降序）。 */
export function readAllEntries(): TimingEntry[] {
  const a = getApp();
  const entries: TimingEntry[] = [];
  for (const f of a.vault.getMarkdownFiles() || []) {
    const lines = cachedLines(f.path);
    if (!lines) continue;
    entries.push(...scanFile(f.path, lines));
  }
  return entries.sort((x, y) => y.start.getTime() - x.start.getTime());
}

/** 只读指定任务 uid 集合下的条目。 */
export function readEntriesForTaskUids(taskUids: unknown[] = []): TimingEntry[] {
  const uids = [...new Set((Array.isArray(taskUids) ? taskUids : []).filter(Boolean))];
  if (uids.length === 0) return [];
  const uidSet = new Set(uids);
  const paths = new Set<string>();
  for (const uid of uids) {
    const parsed = splitUid(String(uid));
    if (parsed) paths.add(parsed.path);
  }
  const entries: TimingEntry[] = [];
  for (const path of paths) {
    const lines = cachedLines(path);
    if (!lines) continue;
    entries.push(...scanFile(path, lines));
  }
  return entries.filter((e) => uidSet.has(e.taskUid)).sort((x, y) => y.start.getTime() - x.start.getTime());
}

/** 读一个任务的原始行，规范化为 timing-core 认识的形式（TODO/DONE 桥接）。 */
export function readBlockString(uid: unknown): string | null {
  if (!uid) return null;
  const parsed = splitUid(String(uid));
  if (!parsed) return null;
  const lines = cachedLines(parsed.path);
  if (!lines || parsed.line < 0 || parsed.line >= lines.length) return null;
  return normalizeTaskString(lines[parsed.line]);
}

/* ─────────────────────────── 写（5） ─────────────────────────── */

/** 一次行级改动。expected 是改动前的【精确行内容】，写回前必须匹配。 */
type LineChange =
  | { kind: 'replace'; line: number; expected: string; next: string }
  | { kind: 'insert'; after: number; afterExpected: string; next: string }
  | { kind: 'remove'; line: number; expected: string };

/** 在行数组里定位目标行：先按记录行号比对内容（uid 快路径），
 *  行号漂了再按内容唯一匹配；找不到或歧义都返回 -1。 */
function locateLine(lines: string[], lineIndex: number, expected: string): number {
  if (lineIndex >= 0 && lineIndex < lines.length && lines[lineIndex] === expected) return lineIndex;
  let found = -1;
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === expected) { found = i; count += 1; }
  }
  return count === 1 ? found : -1;
}

function applyChange(lines: string[], change: LineChange): { ok: boolean; lines: string[]; lineIndex: number } {
  if (change.kind === 'replace' || change.kind === 'remove') {
    const idx = locateLine(lines, change.line, change.expected);
    if (idx < 0) return { ok: false, lines, lineIndex: -1 };
    const next = lines.slice();
    if (change.kind === 'remove') next.splice(idx, 1);
    else next[idx] = change.next;
    return { ok: true, lines: next, lineIndex: idx };
  }
  const idx = locateLine(lines, change.after, change.afterExpected);
  if (idx < 0) return { ok: false, lines, lineIndex: -1 };
  const next = lines.slice();
  next.splice(idx + 1, 0, change.next);
  return { ok: true, lines: next, lineIndex: idx };
}

/** 找文件是否正被某个编辑器打开；是则返回该 Editor。 */
function findEditorFor(path: string): Editor | null {
  let found: Editor | null = null;
  const a = getApp();
  if (typeof a.workspace.iterateAllLeaves === 'function') {
    a.workspace.iterateAllLeaves((leaf: unknown) => {
      if (found) return;
      const view = (leaf as { view?: unknown })?.view as { file?: { path?: string }; editor?: Editor } | undefined;
      if (view?.file?.path === path && view?.editor) found = view.editor;
    });
  }
  return found;
}

async function readFreshLines(path: string): Promise<string[] | null> {
  const a = getApp();
  const f = a.vault.getAbstractFileByPath(path);
  if (!isFileLike(f)) return null;
  const editor = findEditorFor(path);
  if (editor) return editor.getValue().split('\n');
  try {
    const text = await a.vault.read(f as TFile);
    return text.split('\n');
  } catch {
    return null;
  }
}

/** 双通道写回。先校验（applyChange 内容不匹配就抛错，绝不写错行），
 *  再经 Editor API 或 vault.process 落笔，并同步内容缓存。 */
async function writeChange(path: string, change: LineChange): Promise<void> {
  const a = getApp();
  const f = a.vault.getAbstractFileByPath(path);
  if (!isFileLike(f)) throw new Error(`Target file not found: ${path}`);
  const editor = findEditorFor(path);
  if (editor) {
    const lines = editor.getValue().split('\n');
    const r = applyChange(lines, change);
    if (!r.ok) throw new Error('The target line changed while writing. Aborting to avoid corrupting the note.');
    if (change.kind === 'replace') {
      editor.setLine(r.lineIndex, change.next);
    } else if (change.kind === 'insert') {
      // 🔴 必须是 `\n` + 内容，不能是 内容 + `\n`。
      //    锚点是【行尾】，写 `内容\n` 等于把新行拼在锚点行尾巴上
      //    （实测出过 `- [ ] 任务 20m    - LOGBOOK::` 这种脏行），
      //    写 `\n内容` 才是「在锚点行之后另起一行」，与 applyChange 的
      //    splice(idx + 1, 0, next) 语义一致。
      editor.replaceRange(`\n${change.next}`, { line: r.lineIndex, ch: editor.getLine(r.lineIndex).length });
    } else {
      // remove：跨到下一行首删除整行（含换行）；末行则清空内容。
      const last = editor.lineCount() - 1;
      if (r.lineIndex < last) editor.replaceRange('', { line: r.lineIndex, ch: 0 }, { line: r.lineIndex + 1, ch: 0 });
      else editor.replaceRange('', { line: r.lineIndex, ch: 0 }, { line: r.lineIndex, ch: editor.getLine(r.lineIndex).length });
    }
    contentCache.set(path, editor.getValue());
    return;
  }
  const result = await a.vault.process(f as TFile, (data: string) => {
    const lines = data.split('\n');
    const r = applyChange(lines, change);
    if (!r.ok) throw new Error('The target line changed while writing. Aborting to avoid corrupting the note.');
    return r.lines.join('\n');
  });
  contentCache.set(path, result);
}

const INDENT = 4;

/** Clock In：在任务的 LOGBOOK 抽屉下插入一条新的未闭合 CLOCK，并返回它。 */
export async function createRunningClock(
  taskUid: string,
  now: Date,
  knownTaskString = '',
): Promise<{ entry: TimingEntry }> {
  const parsed = splitUid(taskUid);
  if (!parsed) throw new Error('Task not found.');
  const linesRO = await readFreshLines(parsed.path);
  if (!linesRO) throw new Error('Task not found.');
  const lines = linesRO.slice();
  const rawTask = lines[parsed.line];
  if (!rawTask) throw new Error('Task not found.');
  const taskIndent = leadingSpaces(rawTask);
  const normalized = normalizeTaskString(rawTask);
  if (timingCore.taskStatus(normalized) !== 'TODO') {
    throw new Error('Only an unfinished TODO can own the Timing Line.');
  }
  // 定位 LOGBOOK 抽屉。
  let drawerIdx = -1;
  let drawerIndent = -1;
  for (let i = parsed.line + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (leadingSpaces(l) <= taskIndent) break; // 已离开任务子树
    if (isDrawerLine(l.trim())) { drawerIdx = i; drawerIndent = leadingSpaces(l); break; }
  }
  if (drawerIdx < 0) {
    // 🔴 首次给某个任务打卡时【必然没有抽屉】—— 上游那边 Roam 生态里抽屉往往
    //    已经存在，Obsidian 这边不建就等于 Clock In 永远不可用。
    //    紧跟任务行插入一层缩进的 `- LOGBOOK::`，再走下面的正常锚点逻辑。
    const drawerLine = ' '.repeat(taskIndent + INDENT) + '- LOGBOOK::';
    await writeChange(parsed.path, {
      kind: 'insert', after: parsed.line, afterExpected: rawTask, next: drawerLine,
    });
    const refreshed = await readFreshLines(parsed.path);
    if (!refreshed) throw new Error('Could not create the LOGBOOK drawer for this task.');
    lines.length = 0;
    lines.push(...refreshed);
    drawerIdx = parsed.line + 1;
    drawerIndent = taskIndent + INDENT;
    if (!isDrawerLine((lines[drawerIdx] || '').trim())) {
      throw new Error('Could not create the LOGBOOK drawer for this task.');
    }
  }
  // 锚点 = 抽屉下最后一条 CLOCK（复用其缩进/标记），否则锚在抽屉行。
  let anchorIdx = drawerIdx;
  let newIndent = drawerIndent + INDENT;
  let marker = '- ';
  for (let i = drawerIdx + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.trim() || leadingSpaces(l) <= drawerIndent) break;
    if (parseClockLineFromLine(l)) {
      anchorIdx = i;
      const m = /^(\s*)([-*+]\s+)?/.exec(l);
      if (m) { newIndent = m[1].length; marker = m[2] || '- '; }
    }
  }
  const newLine = ' '.repeat(newIndent) + marker + timingCore.formatClockLine(now);
  const anchorRaw = lines[anchorIdx];
  await writeChange(parsed.path, { kind: 'insert', after: anchorIdx, afterExpected: anchorRaw, next: newLine });
  // 确认已写入且为 running。
  const fresh = await readFreshLines(parsed.path);
  if (!fresh) throw new Error('Clock In could not be confirmed.');
  const ci = findClockIndexByStart(fresh, toMs(now), true);
  if (ci < 0) throw new Error('Clock In could not be confirmed.');
  const clockParsed = parseClockLineFromLine(fresh[ci]);
  if (!clockParsed) throw new Error('Clock In could not be confirmed.');
  const taskString = knownTaskString || normalized;
  return {
    entry: {
      ...clockParsed,
      clockUid: `${parsed.path}:${ci}`,
      taskUid,
      taskString,
      title: timingCore.taskTitle(taskString),
      status: timingCore.taskStatus(taskString),
      pageTitle: parsed.path,
    },
  };
}

/** Clock Out：给运行中的 CLOCK 补上结束时刻。已闭合则幂等返回。 */
export async function closeClock(entry: TimingEntry, now: Date): Promise<TimingEntry | false> {
  if (!entry?.running || !entry.clockUid) return false;
  const parsed = splitUid(entry.clockUid);
  if (!parsed) throw new Error('Clock Out could not read the current CLOCK block.');
  const lines = await readFreshLines(parsed.path);
  if (!lines) throw new Error('Clock Out could not read the current CLOCK block.');
  const startMs = toMs(entry.start);
  let idx = findClockIndexByStart(lines, startMs, true);
  if (idx < 0) {
    // 已是闭合状态（外部改动）→ 幂等返回当前值。
    const closedIdx = findClockIndexByStart(lines, startMs, false);
    if (closedIdx >= 0) {
      const current = parseClockLineFromLine(lines[closedIdx]);
      if (current) return { ...entry, ...current };
    }
    throw new Error('Clock Out could not read the current CLOCK block.');
  }
  const rawCurrent = lines[idx];
  const next = clockPrefix(rawCurrent) + timingCore.formatClockLine(entry.start, now);
  await writeChange(parsed.path, { kind: 'replace', line: idx, expected: rawCurrent, next });
  // 确认已闭合。
  const fresh = await readFreshLines(parsed.path);
  if (!fresh) throw new Error('Clock Out could not be confirmed.');
  const ci = findClockIndexByStart(fresh, startMs, false);
  if (ci < 0) throw new Error('Clock Out could not be confirmed.');
  const confirmed = parseClockLineFromLine(fresh[ci]);
  if (!confirmed) throw new Error('Clock Out could not be confirmed.');
  return { ...entry, ...confirmed };
}

/** 删除运行中的 CLOCK 行。 */
export async function deleteClock(entry: TimingEntry): Promise<boolean> {
  if (!entry?.running || !entry.clockUid) throw new Error('Only the current running CLOCK can be deleted.');
  const parsed = splitUid(entry.clockUid);
  if (!parsed) throw new Error('CLOCK block not found.');
  const lines = await readFreshLines(parsed.path);
  if (!lines) throw new Error('CLOCK block not found.');
  const idx = findClockIndexByStart(lines, toMs(entry.start), true);
  if (idx < 0) throw new Error('The CLOCK block changed while deleting. Aborting.');
  const rawCurrent = lines[idx];
  await writeChange(parsed.path, { kind: 'remove', line: idx, expected: rawCurrent });
  return true;
}

/** 更新一条已识别的 CLOCK 行（补结束时间等）。newContent 是 formatClockLine
 *  的裸输出，写回时保留原行前缀。 */
export async function updateGraphBlock(clockUid: string, newContent: string): Promise<boolean> {
  const parsed = splitUid(clockUid);
  if (!parsed) throw new Error('CLOCK block not found.');
  const lines = await readFreshLines(parsed.path);
  if (!lines) throw new Error('CLOCK block not found.');
  const newParsed = parseClockLineFromLine(newContent);
  if (!newParsed) throw new Error('Invalid CLOCK update.');
  const idx = findClockIndexByStart(lines, toMs(newParsed.start), true);
  if (idx < 0) throw new Error('The CLOCK block changed while updating. Aborting.');
  const rawCurrent = lines[idx];
  const next = clockPrefix(rawCurrent) + newContent;
  await writeChange(parsed.path, { kind: 'replace', line: idx, expected: rawCurrent, next });
  return true;
}

/** 勾选完成任务：`- [ ]` → `- [x]`。 */
export async function completeTask(taskUid: string): Promise<boolean> {
  const parsed = splitUid(taskUid);
  if (!parsed) throw new Error('Task not found.');
  const lines = await readFreshLines(parsed.path);
  if (!lines) throw new Error('Task not found.');
  const rawTask = lines[parsed.line];
  if (!rawTask) throw new Error('Only unfinished TODO tasks can be completed.');
  if (timingCore.taskStatus(normalizeTaskString(rawTask)) !== 'TODO') {
    throw new Error('Only unfinished TODO tasks can be completed.');
  }
  const next = rawTask.replace(/\[ \]/, '[x]');
  if (next === rawTask) throw new Error('Could not check off the task.');
  await writeChange(parsed.path, { kind: 'replace', line: parsed.line, expected: rawTask, next });
  // 按内容确认（行号可能漂移）。
  const fresh = await readFreshLines(parsed.path);
  if (!fresh) throw new Error('Task completion could not be confirmed.');
  const ci = locateLine(fresh, parsed.line, next);
  if (ci < 0 || timingCore.taskStatus(normalizeTaskString(fresh[ci])) !== 'DONE') {
    throw new Error('Task completion could not be confirmed.');
  }
  return true;
}

/* ─────────────────────────── 读：readPrimaryPlan ─────────────────────────── */

function localYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dailyNotePath(date: Date): string | null {
  if (host?.dailyNotePath) return host.dailyNotePath(date) || null;
  const a = getApp();
  try {
    const dp = (a as unknown as { internalPlugins?: { getPluginById?: (id: string) => unknown } }).internalPlugins?.getPluginById?.('daily-notes');
    const inst = (dp as { instance?: { getDailyNote?: (date: Date, files: unknown[]) => { path: string } | null } } | undefined)?.instance;
    if (inst && typeof inst.getDailyNote === 'function') {
      const note = inst.getDailyNote(date, a.vault.getMarkdownFiles());
      if (note?.path) return note.path;
    }
  } catch { /* 回落到文件名兜底 */ }
  const ymd = localYMD(date);
  for (const c of [`${ymd}.md`, ymd]) {
    const f = a.vault.getAbstractFileByPath(c);
    if (isFileLike(f)) return f.path;
  }
  return null;
}

const FENCE_OPEN_RE = /^\s*```+\s*(?:nautilus|naut)\s*$/;
const FENCE_CLOSE_RE = /^\s*```+\s*$/;

function emptyPlan(pageTitle: string): PrimaryPlanSnapshot {
  return { pageTitle, pageUid: null, plan: null, rows: [], tasks: [], reviewTasks: [], fixedEvents: [] };
}

/** 今日 Daily Note 里第一个 nautilus 代码块【之后】的计划。
 *  边界规则复用 src/blockconfig.ts 的 extractPlanBody，不重写。 */
export function readPrimaryPlan(date = new Date(), fallbackMinutes = 15): PrimaryPlanSnapshot {
  const path = dailyNotePath(date);
  const pageTitle = path || localYMD(date);
  if (!path) return emptyPlan(pageTitle);
  const lines = cachedLines(path);
  if (!lines) return emptyPlan(pageTitle);
  // 找第一个 nautilus 代码块的闭合围栏行号。
  let fenceClose = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!FENCE_OPEN_RE.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j])) j += 1;
    if (j < lines.length) { fenceClose = j; break; }
  }
  if (fenceClose < 0) return emptyPlan(pageTitle);
  const { body, startLine } = extractPlanBody(lines.join('\n'), fenceClose);
  const planUid = `${path}:${fenceClose}`;
  const bodyLines = body.length ? body.split('\n') : [];
  // 🔴 `parentUid` 必须按【缩进】还原层级，不能一律填 planUid。
  //    上游 projectPlan / projectReviewTasks / projectFixedEvents 三处都靠
  //    `row.parentUid === planUid` 只取【直接子级】（文案就叫 direct-child）。
  //    Roam 里 block 自带真实 parentUid，过滤天然成立；这边把正文拍平的话
  //    过滤恒为真 => 嵌套子步骤会冒进 Plan/Review 面板，还被套上 15m 默认
  //    预算，而容量条根本没算它们 —— 两个数字自相矛盾。螺旋图那侧
  //    （parser.ts 的 baseIndent）早就跳过子项了，执行层必须跟上。
  const uids = bodyLines.map((_, k) => `${path}:${startLine + k}`);
  const indents = bodyLines.map((raw) => leadingSpaces(raw));
  const rows: PlanRow[] = bodyLines.map((raw, k) => {
    // 父 = 往前最近的一行【缩进更小】的非空行；找不到就是计划块本身。
    let parentUid = planUid;
    for (let j = k - 1; j >= 0; j -= 1) {
      if (!bodyLines[j].trim()) continue;
      if (indents[j] < indents[k]) { parentUid = uids[j]; break; }
    }
    return { uid: uids[k], string: normalizeTaskString(raw), order: k, parentUid };
  });
  // 🔴 上游 HEAD 起 TODO 标记变成【可选】：projectDirectTasks 的过滤器清空了，
  //    计划块的任何直接子行只要不是时间段就成为弹性任务（隐式 TODO）。
  //    ⛔ 本移植【有意不跟随】—— 决策与理由见 docs/PORTING-DECISIONS.md §D1。
  //    Obsidian 的日记里随手写的 bullet 太常见，隐式成任务会凭空吃掉容量。
  //    🔴 实现方式是【不喂给引擎】，不是改 vendor —— vendor 必须保持零修改，
  //    否则以后无法 diff 对账。只滤直接子级；嵌套行本来就被 parentUid 挡掉。
  const planRows = rows.filter((row) => (
    row.parentUid !== planUid
    || !!timingCore.taskStatus(row.string)
    || !!timingCore.parseTimeRangeMinutes(row.string)
  ));

  return {
    pageTitle,
    pageUid: path,
    plan: { uid: planUid, string: '', order: 0, parentUid: null },
    rows: planRows,
    tasks: timingCore.projectPlan(planRows, planUid, fallbackMinutes),
    reviewTasks: timingCore.projectReviewTasks(planRows, planUid, fallbackMinutes),
    fixedEvents: timingCore.projectFixedEvents(planRows, planUid),
  };
}

/* ─────────────────────────── 导航（5） ─────────────────────────── */

function defer(fn: () => void, ms: number): void {
  const globalTimer = (globalThis as unknown as { setTimeout?: (f: () => void, n: number) => unknown }).setTimeout;
  const timer = typeof window !== 'undefined' && typeof window.setTimeout === 'function' ? window.setTimeout : globalTimer;
  if (typeof timer === 'function') timer(fn, ms);
}

function activeEditor(): Editor | null {
  const a = getApp();
  const leaf = (a.workspace as unknown as { getActiveLeaf?: () => { view?: unknown } }).getActiveLeaf?.();
  return (leaf?.view as { editor?: Editor } | undefined)?.editor || null;
}

function revealLine(line: number): void {
  const editor = activeEditor();
  if (!editor) return;
  const target = Math.max(0, Math.min(line, editor.lineCount() - 1));
  editor.setCursor({ line: target, ch: 0 });
  editor.scrollIntoView({ from: { line: target, ch: 0 }, to: { line: target, ch: 0 } }, true);
}

async function openTaskLeaf(taskUid: string, side: 'main' | 'right'): Promise<void> {
  const parsed = splitUid(taskUid);
  if (!parsed) throw new Error('This task has no file path.');
  const a = getApp();
  const f = a.vault.getAbstractFileByPath(parsed.path);
  if (!isFileLike(f)) throw new Error('This task has no file path.');
  const leaf = side === 'right' ? a.workspace.getRightLeaf(false) : a.workspace.getLeaf(false);
  if (!leaf) throw new Error('Could not open the task: no workspace leaf available.');
  await leaf.openFile(f as TFile);
  revealLine(parsed.line);
  window.setTimeout(() => revealLine(parsed.line), 60);
}

export async function openTaskInMainWindow(taskUid: string): Promise<{ ok: boolean }> {
  await openTaskLeaf(taskUid, 'main');
  return { ok: true };
}

export function frontBlockInRightSidebar(taskUid: string): Promise<{ ok: boolean; skipped?: boolean; reason?: string; message?: string; error?: unknown }> {
  if (!taskUid) return Promise.resolve({ ok: false, reason: 'missing-uid' });
  return Promise.resolve()
    .then(() => openTaskLeaf(taskUid, 'right'))
    .then(() => ({ ok: true }))
    .catch((error: unknown) => ({
      ok: false,
      reason: 'sidebar-front-failed',
      message: error instanceof Error ? error.message : 'Could not open this task in the right sidebar.',
      error,
    }));
}

export async function openTaskInRightSidebar(taskUid: string): Promise<{ ok: boolean; skipped?: boolean; reason?: string; message?: string; error?: unknown }> {
  const result = await frontBlockInRightSidebar(taskUid);
  if (!result.ok && !result.skipped) {
    throw new Error(result.message || 'Could not open this task in the right sidebar.');
  }
  return result;
}

/** 打开今天的计划。`sidebar: true` 时送右侧栏而不是主编辑区。
 *  🔴 第二参是上游 HEAD 加的（d807ea4 / 7850e58），签名必须跟着改，
 *     否则 runtime 的 `locate(options)` 传进来的 `{sidebar}` 会被静默丢弃。
 *     这是本轮升级里唯一破坏适配层签名的上游改动。 */
export async function openPrimaryPlan(
  planUid: string,
  { sidebar = false }: { sidebar?: boolean } = {},
): Promise<void> {
  const parsed = splitUid(planUid);
  if (!parsed) throw new Error('No Primary Nautilus Log was found today.');
  if (sidebar) { await openTaskInRightSidebar(planUid); return; }
  const a = getApp();
  const f = a.vault.getAbstractFileByPath(parsed.path);
  if (!isFileLike(f)) throw new Error('No Primary Nautilus Log was found today.');
  const leaf = a.workspace.getLeaf(false);
  if (!leaf) throw new Error('Could not open the plan: no workspace leaf available.');
  await leaf.openFile(f as TFile);
  revealLine(parsed.line);
  window.setTimeout(() => revealLine(parsed.line), 80);
}

export function warmRightSidebarWindowCache(): Promise<{ ok: boolean; reason: string }> {
  // Obsidian 的右侧边栏是单个 leaf，没有 Roam 那种多窗口栈，也无窗口缓存可预热。
  // 运行时在启动后异步调它；实现成 no-op 以保持调用形状不变。
  return Promise.resolve({ ok: false, reason: 'unavailable' });
}

/* ─────────────────────────── 杂项（3） ─────────────────────────── */

export function showToast(message: string, intent: 'warning' | 'danger' = 'warning'): void {
  const h = host;
  if (h?.notify) { h.notify(message, intent); return; }
  console[intent === 'danger' ? 'error' : 'warn'](`[Nautilus Log] ${message}`);
}

export function legacyLogbookIsRunning(): boolean {
  // Obsidian 没有 Roam Logbook 这类会抢写 LOGBOOK 的扩展；其它可能写 LOGBOOK
  // 抽屉的插件也没有可靠的探测信号。拿不准就返回 false，避免误伤启动。
  return false;
}

/* ─────────────────────────── 诊断 ───────────────────────────
 * 执行层「找不到今天的 Nautilus Log」时，把链路上每一环的实际取值报出来。
 * 🔴 这条链有四个独立的失败点（注入的路径 / 文件存在 / 同步缓存命中 /
 *    围栏正则命中），靠猜会连着猜错——本项目在这上面栽过三次。 */
export function diagnoseTiming(date = new Date()): string {
  if (!host) return 'adapter 未初始化';
  const path = dailyNotePath(date);
  if (!path) return 'dailyNotePath() = null（定位不到今日笔记）';
  const a = getApp();
  const exists = isFileLike(a.vault.getAbstractFileByPath(path));
  const lines = cachedLines(path);
  if (!lines) {
    return `path=${path} · 文件存在=${exists} · 同步缓存未命中（cache size=${contentCache.size}）`;
  }
  let fenceOpen = -1; let fenceClose = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!FENCE_OPEN_RE.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j])) j += 1;
    if (j < lines.length) { fenceOpen = i; fenceClose = j; break; }
  }
  if (fenceClose < 0) return `path=${path} · 行数=${lines.length} · 未找到 nautilus 围栏`;
  const snap = readPrimaryPlan(date);
  return `path=${path} · 围栏=${fenceOpen}..${fenceClose} · rows=${snap.rows.length}`
    + ` · tasks=${snap.tasks.length} · events=${snap.fixedEvents.length}`;
}
