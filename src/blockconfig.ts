/*
 * 方案 5 的两半：
 *   ```nautilus``` 块里放【当天的配置覆盖】（YAML frontmatter 风格）
 *   块【后面】的普通 Markdown 列表是【数据】——始终可编辑、进 Obsidian 全局索引
 *
 * 为什么不把数据放进块里（2026-08-24 改）：
 * Obsidian 里代码块吃掉源码是可接受的（Dataview 就这样），但前提是块里装的是
 * 「查询/配置」而不是「数据」。任务清单是要反复读改的东西，被渲染结果吃掉就废了
 * ——实测：阅读模式有图无文、源码模式有文无图，无法并行。
 */

import type { NautilusSettings } from './contract';

/** 计划边界：任何空白行。
 *  （不用标题作边界——很多 Obsidian 用户根本不写标题。） */
const BLANK_RE = /^\s*$/;

/** 块内配置的可覆盖项。留空则沿用全局设置。 */
export interface BlockOverrides {
  workdayStartHour?: number;
  workdayEndHour?: number;
  todoDuration?: number;
  descLength?: number;
  urgentTrigger?: string;
  language?: 'en' | 'zh';
  /** 无法识别的键，原样报出来供 UI 提示，不静默吞掉。 */
  unknown: { key: string; value: string }[];
}

/** `05:00` / `5` / `5:30`(向下取整到小时) → 小时数；识别不了返回 null。 */
function parseHour(raw: string): number | null {
  const t = raw.trim();
  const m = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  if (!Number.isFinite(h) || h < 0 || h > 24) return null;
  return h;
}

function parseInt_(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/** 解析 ```nautilus``` 块的内容。YAML frontmatter 风格的 `key: value`。
 *  空块＝完全沿用全局设置，这是合法且常见的写法。 */
export function parseBlockConfig(source: string): BlockOverrides {
  const out: BlockOverrides = { unknown: [] };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;          // 空行与注释
    const idx = line.indexOf(':');
    if (idx < 0) { out.unknown.push({ key: line, value: '' }); continue; }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    switch (key) {
      case 'start': case 'start-time': case 'workday-start': {
        const h = parseHour(value); if (h !== null) out.workdayStartHour = h;
        else out.unknown.push({ key, value });
        break;
      }
      case 'end': case 'end-time': case 'workday-end': {
        const h = parseHour(value); if (h !== null) out.workdayEndHour = h;
        else out.unknown.push({ key, value });
        break;
      }
      case 'default-duration': case 'todo-duration': {
        const n = parseInt_(value); if (n !== null) out.todoDuration = n;
        else out.unknown.push({ key, value });
        break;
      }
      case 'legend-length': case 'desc-length': {
        const n = parseInt_(value); if (n !== null) out.descLength = n;
        else out.unknown.push({ key, value });
        break;
      }
      case 'urgent': case 'urgent-trigger':
        out.urgentTrigger = value; break;
      case 'language': case 'lang':
        if (value === 'en' || value === 'zh') out.language = value;
        else out.unknown.push({ key, value });
        break;
      default:
        out.unknown.push({ key, value });
    }
  }
  return out;
}

/** 把块内覆盖叠加到全局设置上。 */
export function applyOverrides(base: NautilusSettings, o: BlockOverrides): NautilusSettings {
  return {
    ...base,
    ...(o.workdayStartHour !== undefined ? { workdayStartHour: o.workdayStartHour } : {}),
    ...(o.workdayEndHour !== undefined ? { workdayEndHour: o.workdayEndHour } : {}),
    ...(o.todoDuration !== undefined ? { todoDuration: o.todoDuration } : {}),
    ...(o.descLength !== undefined ? { descLength: o.descLength } : {}),
    ...(o.urgentTrigger !== undefined ? { urgentTrigger: o.urgentTrigger } : {}),
    ...(o.language !== undefined ? { language: o.language } : {}),
  };
}

/** 从整篇笔记里切出计划正文：代码块【之后】到【第一个空白行】之间。
 *  返回文本 + 它在文件中的起始行号（uid 要用真实行号，不能用相对偏移）。 */
export function extractPlanBody(
  fileText: string,
  blockLineEnd: number,
): { body: string; startLine: number } {
  const lines = fileText.split(/\r?\n/);
  let i = blockLineEnd + 1;
  // 允许块与计划之间有若干空行（否则用户多敲一个回车就整个失效，太脆）
  while (i < lines.length && BLANK_RE.test(lines[i])) i += 1;
  const startLine = i;
  const collected: string[] = [];
  while (i < lines.length && !BLANK_RE.test(lines[i])) {
    collected.push(lines[i]);
    i += 1;
  }
  return { body: collected.join('\n'), startLine };
}
