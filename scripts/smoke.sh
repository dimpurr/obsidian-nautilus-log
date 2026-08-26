#!/usr/bin/env bash
# 真机冒烟 —— 装插件 → Force Reload → 截图 → 断言侧栏关键文本。
#
# 为什么必须有这一步：`npm test` 全绿、`npm run build` 成功，真机上侧栏
# 仍可能只剩一个光秃秃的螺旋。2026-08-26 这一天，只有真机回路抓到了两个问题：
#   ① 补上 container-type 激活了此前是死代码的 @container 块，紧凑组件
#      却还没接线 => 完整头部被藏、紧凑视图又是空的
#   ② 执行层改成延后启动后，侧栏在那之前就渲染完了，执行区永远空着
# 两个都是「跨模块的组合失效」，单元测试原理上看不见。
#
# 依赖：cua-driver（宿主侧 computer-use，见 DimCollabS knowledge/tools/Cua-Driver.md）
#      daemon 要活着：cua-driver status / cua-driver serve
#
# 用法：
#   VAULT=~/path/to/vault scripts/smoke.sh              # 自动找 Obsidian 窗口
#   VAULT=... WINDOW_TITLE='DimLifeS' scripts/smoke.sh  # 指定窗口
#
# 🔴 零写死 path：机器 / vault 特定值一律 env 注入（DimCollabS knowledge/README
#    的「SOP 附带脚本」条例）。

set -euo pipefail

VAULT="${VAULT:?请用 VAULT=<vault 绝对路径> 调用}"
WINDOW_TITLE="${WINDOW_TITLE:-Obsidian}"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}/nautilus-smoke}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$VAULT/.obsidian/plugins/nautilus-log"

command -v cua-driver >/dev/null || { echo "✗ 未找到 cua-driver"; exit 1; }
cua-driver status >/dev/null 2>&1 || { echo "✗ cua-driver daemon 没起：cua-driver serve"; exit 1; }
[ -d "$PLUGIN_DIR" ] || { echo "✗ 插件目录不存在：$PLUGIN_DIR"; exit 1; }

mkdir -p "$OUT_DIR"

echo "▸ 构建并安装"
( cd "$HERE" && npm run build >/dev/null )
cp "$HERE"/{main.js,manifest.json,styles.css} "$PLUGIN_DIR/"

echo "▸ 定位 Obsidian 窗口（title 含 '$WINDOW_TITLE'）"
read -r PID WID <<<"$(cua-driver list_windows '{}' 2>/dev/null | python3 -c "
import json,sys,os
want=os.environ['WINDOW_TITLE']
for w in json.load(sys.stdin)['windows']:
    if w['app_name']=='Obsidian' and want in (w['title'] or ''):
        print(w['pid'], w['window_id']); break
else:
    raise SystemExit('✗ 未找到匹配窗口')
")"
echo "  pid=$PID window=$WID"

echo "▸ Force Reload"
cua-driver invoke_menu "{\"pid\":$PID,\"window_id\":$WID,\"path\":[\"View\",\"Force Reload\"]}" >/dev/null
sleep "${RELOAD_WAIT:-24}"

echo "▸ 读 AX 树断言"
cua-driver call get_window_state "{\"pid\":$PID,\"window_id\":$WID}" 2>/dev/null > "$OUT_DIR/ax.json"
python3 - "$OUT_DIR/ax.json" <<'PY'
import json, sys
blob = json.dumps(json.load(open(sys.argv[1])), ensure_ascii=False)
# 关键面：容量头部、执行层三视图、紧凑清单。少任何一个都说明组合失效了。
checks = [
    ('容量头部',   ['planned', 'left']),
    ('执行层面板', ['Timing', 'Plan', 'Review']),
    ('定位按钮',   ['Locate']),
]
bad = []
for label, needles in checks:
    missing = [n for n in needles if n not in blob]
    if missing:
        bad.append(f'{label}: 缺 {missing}')
for line in bad:
    print(f'  ✗ {line}')
if bad:
    print('\n真机与测试不一致 —— 这正是单元测试看不见的那一类。')
    sys.exit(1)
print('  ✓ 容量头部 / 执行层三视图 / 定位按钮 全部在场')
PY

echo "▸ 截图留档"
cua-driver call zoom "{\"pid\":$PID,\"window_id\":$WID,\"x1\":2480,\"y1\":0,\"x2\":3456,\"y2\":1700}" 2>/dev/null \
  | python3 -c "
import json,sys,base64,os
d=json.load(sys.stdin)
p=os.path.join(os.environ['OUT_DIR'],'sidebar.jpg')
open(p,'wb').write(base64.b64decode(d['screenshot_png_b64']))
print('  ->',p)
" OUT_DIR="$OUT_DIR" || echo "  (截图失败，不影响断言结果)"

echo "✅ 冒烟通过"
