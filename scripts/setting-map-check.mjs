/*
 * 设置键映射的机械核对（T2-119 的防复发面）。
 *
 * 检测器 4（键名空间）只证明「kebab 字面量【出现在 main.ts 的某个地方】」，
 * 那个字面量出现在注释里 / 出现在别的对象里 / 出现在字符串拼接里，都算命中
 * —— 检测器却无从知道它到底是不是 SETTINGS_KEY_MAP 的键、映射目标对不对。
 * 这里的三个纯函数把两件事变成机械判定：
 *
 *   1. vendor 要求的每个 kebab 键，必须【恰好】是 SETTINGS_KEY_MAP 的一个键
 *      （精确键名成员关系，不是子串包含）。
 *   2. SETTINGS_KEY_MAP 每个映射目标，必须是 NautilusSettings 的真实字段
 *      （挡「合法但指错字段」以下的一切笔误；=== 字段名字面量级核对）。
 *
 * ⚠️ 机械判定的边界：两件事【仍查不出来】，靠 TS 类型 + 人工核对：
 *   · 「合法但错误的映射目标」（如 'workday-start' 指到 workdayEndHour）——
 *     kebab→camel 的【语义】没有第二份真相可对，正则做不出「对不对」。
 *     TS 的 `Record<string, keyof NautilusSettings>` 连「非法字段」都挡不住时
 *     才轮到这个名字级核对；语义级正确性只能靠 §D7 的升级核对流程。
 *   · `POMODORO_STATE_KEY` 这类【变量键】根本不进 `settings.get('...')`
 *     字面量集合，靠 §D7 的 shim 第三层兜底兜住（认证审计 P1-066）。
 */

/** 从 main.ts 里精确扒出 SETTINGS_KEY_MAP（kebab 键 → camel 目标）。 */
export function extractSettingsKeyMap(mainText) {
  const m = /const\s+SETTINGS_KEY_MAP[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(mainText);
  if (!m) return { keys: new Set(), targets: new Map() };
  const keys = new Set();
  const targets = new Map();
  for (const [, k, v] of m[1].matchAll(/['"]([^'"\n]+)['"]\s*:\s*['"]([^'"\n]+)['"]/g)) {
    keys.add(k);
    targets.set(k, v);
  }
  return { keys, targets };
}

/** 从 contract.ts 里扒出 NautilusSettings 的全部字段名（做映射目标的真相）。 */
export function extractNautilusFieldNames(contractText) {
  const m = /interface\s+NautilusSettings\s*\{([\s\S]*?)\n\}/.exec(contractText);
  if (!m) return new Set();
  return new Set(
    [...m[1].matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)].map((x) => x[1]),
  );
}

/**
 * 核心判定：给定 vendor 要求的 kebab 键集合，返回
 *   { missingKeys, badTargets }
 *   missingKeys — vendor 要了、但 SETTINGS_KEY_MAP 里没有精确对应键的
 *   badTargets  — 映射目标的字段名不是 NautilusSettings 真实字段的
 */
export function analyzeSettingKeyMap(mainText, contractText, askedKeys) {
  const { keys, targets } = extractSettingsKeyMap(mainText || '');
  const fields = extractNautilusFieldNames(contractText || '');
  const missingKeys = [...new Set(askedKeys)]
    .filter((k) => !keys.has(k))
    .sort();
  const badTargets = [...targets.entries()]
    .filter(([, v]) => !fields.has(v))
    .map(([k, v]) => [k, v])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { missingKeys, badTargets };
}