"use strict";
/*
 * detector-mapping.test.js — T2-119 的防复发测试。
 *
 * 认证审计发现检测器 4（键名空间）只查「kebab 字面量出现在 main.ts 的某个
 * 地方」：字面量写在注释里、映射目标拼错了，它一概放行。本测试把一份临时
 * 仓库副本里的 SETTINGS_KEY_MAP 弄坏，断言检测器必须红；
 * 弄坏的方式特意挑「旧检测器会放过、新检测器才抓得住」的两种：
 *   1. 把一个映射条目【整个删掉】，但把它的字面量留在注释里 —— 旧逻辑的
 *      `main.includes("'recent-retention-minutes'")` 仍然成立，照样放行。
 *   2. 把一个映射目标的字段名【写错】，但键还在 —— 旧逻辑根本不看目标。
 *
 * 回退修复（把 unmappedSettingKeys 改回子串包含判定）这条测试就会红。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
} = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { pathToFileURL } = require("node:url");

const execFileP = promisify(execFile);
const ROOT = join(__dirname, "..");
const DETECTOR = join(ROOT, "scripts", "audit-detectors.mjs");

function buildSabotagedCopy() {
  const work = mkdtempSync(join(tmpdir(), "nautilus-detector-map-"));
  cpSync(ROOT, work, {
    recursive: true,
    filter: (p) => !p.includes(`${require("node:path").sep}node_modules`)
      && !p.includes(`${require("node:path").sep}.git`),
  });
  const mainPath = join(work, "src", "main.ts");
  const original = readFileSync(mainPath, "utf8");
  const sabotaged = original
    .split("\n")
    .map((line) => {
      if (line.includes("'recent-retention-minutes': 'recentRetentionMinutes'")) {
        return "    // (T2-119 sabotage) 条目已从映射表删掉，只留注释里的字面量";
      }
      if (line.includes("'workday-start': 'workdayStartHour'")) {
        return line.replace("'workdayStartHour',", "'workdayStartHourr',");
      }
      return line;
    })
    .join("\n")
    + "\n// (T2-119 sabotage) 'recent-retention-minutes' 现在只活在注释里。\n";
  writeFileSync(mainPath, sabotaged);
  return work;
}

async function runDetector(work) {
  const env = { ...process.env };
  if (work) env.NT_AUDIT_ROOT = work;
  return execFileP(process.execPath, [DETECTOR, "--json"], { env, cwd: ROOT })
    .then(({ stdout }) => JSON.parse(stdout))
    .catch((err) => {
      const json = JSON.parse(err.stdout);
      json.nonZeroExit = true;
      return json;
    });
}

test("T2-119 · 纯函数：按精确键名成员关系与字段真相核对映射", async () => {
  const helper = await import(pathToFileURL(join(ROOT, "scripts", "setting-map-check.mjs")));
  // 这套断言读的是仓库里的【真】src/main.ts 与 src/contract.ts（空转测试检测器
  // 要求测试必须接触 src/ —— 这里碰的正是被测映射关系的本源）。
  const main = readFileSync(join(ROOT, "src/main.ts"), "utf8");
  const contract = readFileSync(join(ROOT, "src/contract.ts"), "utf8");

  const { keys, targets } = helper.extractSettingsKeyMap(main);
  assert.equal(keys.has("workday-start"), true);
  assert.equal(keys.has("language"), true);
  assert.equal(targets.get("workday-start"), "workdayStartHour");
  assert.equal(targets.size, 9);

  const fields = helper.extractNautilusFieldNames(contract);
  assert.equal(fields.has("workdayStartHour"), true);
  assert.equal(fields.has("actualTimeTracking"), true);
  assert.equal(fields.has("prefixStr"), false, "prefix-str 有意不移植（§D12），不该出现在字段里");

  // 键存在、目标正确 → 干净
  const clean = helper.analyzeSettingKeyMap(main, contract, ["workday-start"]);
  assert.deepEqual(clean, { missingKeys: [], badTargets: [] });

  // 键写了但 vendor 要的键不在地图里（只在注释里）→ 必须被抓
  const missingOnly = helper.analyzeSettingKeyMap(main, contract, ["ghost-key", "language"]);
  assert.deepEqual(missingOnly, { missingKeys: ["ghost-key"], badTargets: [] });

  // 映射目标字段名拼错 → 必须被抓
  const typo = helper.analyzeSettingKeyMap(
    main.replace("'workdayStartHour',", "'workdayStartHourr',"),
    contract,
    ["workday-start"],
  );
  assert.deepEqual(typo, { missingKeys: [], badTargets: [["workday-start", "workdayStartHourr"]] });
});

test("T2-119 · 检测器在干净仓库上必须不红（回归护栏）", async () => {
  const out = await runDetector(ROOT);
  assert.equal(out.nonZeroExit, undefined, "干净仓库应当 exit 0");
  assert.equal((out.regressions.unmappedSettingKeys || []).length, 0);
});

test("T2-119 · 弄坏映射目标（删条目留注释 + 字段名拼错）检测器必须红", async () => {
  const work = buildSabotagedCopy();
  try {
    const out = await runDetector(work);
    assert.equal(out.nonZeroExit, true, "被弄坏的副本必须让检测器退出非 0");
    const fresh = out.regressions.unmappedSettingKeys || [];
    assert.ok(
      fresh.includes("recent-retention-minutes"),
      `删除映射条目必须在注释字面量面前仍然被抓，实际未见该键：${JSON.stringify(fresh)}`,
    );
    assert.ok(
      fresh.includes("SETTINGS_KEY_MAP.target[workday-start]→workdayStartHourr"),
      "映射目标字段名写错必须被抓",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("T1-127 · 弄坏 parser.ts 抄来的正则，平行正则检测器必须红", async () => {
  const work = mkdtempSync(join(tmpdir(), "nautilus-detector-regex-"));
  try {
    cpSync(ROOT, work, {
      recursive: true,
      filter: (p) => !p.includes(`${require("node:path").sep}node_modules`)
        && !p.includes(`${require("node:path").sep}.git`),
    });
    const parserPath = join(work, "src", "parser.ts");
    const original = readFileSync(parserPath, "utf8");
    // 把抄来的 dHH:MM 正则悄悄改一个字符（旧实现没有这条检测器 → 静默）
    writeFileSync(
      parserPath,
      original.replace(
        "const DONE_AT_RE = /(?:^|\\s)d(\\d{1,2})(?::(\\d{1,2}))?(?=\\s|$)/i;",
        "const DONE_AT_RE = /(?:^|\\s)d(\\d{1,2})(?::(\\d{1,2}))?(?=\\s|$)$/i; // (T1-127 sabotage)",
      ),
    );
    const out = await runDetector(work);
    assert.equal(out.nonZeroExit, true, "被改坏的正则必须让检测器退出非 0");
    assert.ok(
      (out.regressions.parallelRegexDrift || []).some((x) => x.includes("DONE_AT_RE")),
      "平行正则漂移必须被检出",
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});