#!/usr/bin/env bash
# doctor.sh — 只读自检（npm run doctor）。不改任何文件、不打印密钥。
#   [OK] 正常  [WARN] 能用但有隐患  [FAIL] 必须修
# 退出码：有 FAIL 为 1，否则 0。
# 最终验收标准：关掉 Muse 网页，只用手机飞书给机器人发消息，能收到回复才算部署完成。
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 2
FAILS=0 WARNS=0
ok()   { echo "[OK]   $*"; }
warn() { echo "[WARN] $*"; WARNS=$((WARNS + 1)); }
fail() { echo "[FAIL] $*"; FAILS=$((FAILS + 1)); }
now="$(date +%s)"
mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
HOOK_ID="feishu-inbox-watch"

# ---- 运行环境 ----
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${major:-0}" -ge 20 ] 2>/dev/null; then ok "Node.js $(node -v)"; else fail "Node.js 版本过低（$(node -v)），需要 20+"; fi
else
  fail "找不到 node"
fi
[ -d node_modules/@larksuiteoapi/node-sdk ] && ok "依赖已安装" || fail "依赖没装：npm ci"
if [ -f dist/daemon.js ]; then
  newest_src="$(find src -name '*.ts' -newer dist/daemon.js 2>/dev/null | head -1)"
  if [ -n "$newest_src" ]; then warn "源码比编译产物新（如 $newest_src）：更新后要 npm run build 并重启 daemon"; else ok "已编译（dist/daemon.js）"; fi
else
  fail "没编译：npm run build"
fi
HAS_JQ=0
if command -v jq >/dev/null 2>&1; then HAS_JQ=1; ok "jq 可用（hook 需要）"; else fail "找不到 jq，hook 脚本跑不起来"; fi
command -v python3 >/dev/null 2>&1 && ok "python3 可用（hook 维护多轮上下文需要）" || fail "找不到 python3：hook 照常唤醒，但多轮上下文、/clear、/compact 全部失效"

# ---- 凭证与配置 ----
if [ -f secrets.env ]; then
  perm="$(stat -c %a secrets.env 2>/dev/null || echo '?')"
  [ "$perm" = "600" ] && ok "secrets.env 权限 600" || warn "secrets.env 权限是 $perm，建议 chmod 600"
  if grep -Eq '^\s*(export\s+)?(FEISHU_APP_ID|APP_ID)\s*=\s*cli_[A-Za-z0-9]+' secrets.env && grep -Eq '^\s*(export\s+)?(FEISHU_APP_SECRET|APP_SECRET)\s*=\s*\S+' secrets.env; then
    ok "secrets.env 有 App ID / Secret（不显示）"
  else
    fail "secrets.env 缺 FEISHU_APP_ID / FEISHU_APP_SECRET：npm run onboard 扫码，或手动填"
  fi
else
  fail "没有 secrets.env：npm run onboard 扫码建应用"
fi
if [ -f config.json ]; then
  if [ "$HAS_JQ" -eq 0 ]; then
    warn "没有 jq，跳过 config.json 内容检查（npm run check-config 可以查）"
  elif jq -e . config.json >/dev/null 2>&1; then
    n="$(jq '[.allowedOpenIds // [] | .[] | select(type == "string" and startswith("ou_") and (test("^ou_x+$"; "i") | not))] | length' config.json)"
    placeholder="$(jq '[.allowedOpenIds // [] | .[] | select(type == "string" and test("^ou_x+$"; "i"))] | length' config.json)"
    if [ "${placeholder:-0}" -gt 0 ] && [ "${n:-0}" -gt 0 ]; then warn "白名单 $n 人，另有占位符 ou_xxx 没删（不影响使用，可以删掉）"
    elif [ "${placeholder:-0}" -gt 0 ]; then fail "config.json 的 allowedOpenIds 里还是占位符 ou_xxx：daemon 能启动，但所有人的消息都会被拦下。给机器人发条私聊，在 debug.log 里找 daemon.blocked_not_allowed 那行的 sender（ou_ 开头）填进去后重启"
    elif [ "${n:-0}" -gt 0 ]; then ok "白名单 $n 人"
    else fail "config.json 的 allowedOpenIds 为空（daemon 会拒绝启动）"; fi
    [ "$(jq -r '.streamReplies // true' config.json)" = "false" ] && warn "streamReplies=false：流式打字机已关闭"
  else
    fail "config.json 不是合法 JSON"
  fi
else
  fail "没有 config.json"
fi

# ---- daemon ----
if bash keepalive.sh --status >/dev/null 2>&1; then
  ok "daemon 健康（身份核实 + 长连接已连接）"
else
  if [ -f heartbeat.json ]; then
    hb_ts="$(jq -r '((.ts // 0) / 1000 | floor)' heartbeat.json 2>/dev/null || echo 0)"
    hb_conn="$(jq -r '.connected // false' heartbeat.json 2>/dev/null || echo false)"
    fail "daemon 不健康：心跳 $(( (now - hb_ts) / 60 )) 分钟前，connected=$hb_conn。运行 bash keepalive.sh 拉起，再看 daemon.log"
  else
    fail "daemon 没在运行（没有心跳文件）：bash keepalive.sh"
  fi
fi
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "muse-feishu-bridge keepalive ($ROOT)"; then
  crontab -l 2>/dev/null | grep -F "muse-feishu-bridge keepalive ($ROOT)" | grep -q "NODE_BIN=" ||
    warn "cron 条目没写 node 路径（cron 的 PATH 里可能找不到 node）：重新运行 bash keepalive.sh --install-cron"
  if pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; then ok "cron 保活已安装且 cron 在运行"; else warn "cron 条目在但 cron 服务没运行（hook 会兜底拉起，但最好 service cron start）"; fi
else
  warn "没装 cron 保活（bash keepalive.sh --install-cron）；hook 每 5 秒会兜底拉起"
fi
for f in daemon.log debug.log; do
  [ -f "$f" ] || continue
  if tail -n 2000 "$f" 2>/dev/null | grep -q "cardkit_disabled"; then
    warn "流式打字机已回退成逐段刷新（缺 cardkit:card:write 权限）：npm run onboard -- --update-permissions 扫码补上后重启 daemon"
    break
  fi
done

# ---- Muse hook ----
HOOK_SH="$HOME/hooks/scripts/$HOOK_ID.sh"
HOOK_DEF="$HOME/hooks/definitions/$HOOK_ID.json"
if [ -f "$HOOK_SH" ]; then
  if grep -q '^resolve_bridge_root()' "$HOOK_SH"; then
    # 新版 hook 自动定位桥接目录：用 hook 自己的函数算一遍（只定义函数，不跑轮询）
    hook_root="$(bash -c 'eval "$(sed -n "/^DEFAULT_BRIDGE_ROOT=/,/^BRIDGE_ROOT=/p" "$1" | sed "\$d")"; resolve_bridge_root' _ "$HOOK_SH" 2>/dev/null)"
  else
    hook_root="$(sed -n 's/^BRIDGE_ROOT="\(.*\)".*/\1/p' "$HOOK_SH" | head -1)"
    hook_root="${hook_root//\$HOME/$HOME}"
  fi
  if [ -n "$hook_root" ] && [ "$(cd "$hook_root" 2>/dev/null && pwd)" != "$ROOT" ]; then
    fail "hook 脚本的 BRIDGE_ROOT（$hook_root）不是本目录（$ROOT）：消息会没人处理（装了多份时设 MUSE_FEISHU_ROOT 或改脚本里的 DEFAULT_BRIDGE_ROOT）"
  else
    ok "hook 脚本存在：$HOOK_SH"
  fi
  if ! cmp -s "$HOOK_SH" hooks/$HOOK_ID.sh; then
    warn "hook 脚本和仓库里的不一致（更新后没复制？）：cp hooks/$HOOK_ID.sh $HOOK_SH"
  fi
else
  fail "hook 脚本不存在：$HOOK_SH（cp hooks/$HOOK_ID.sh 过去）"
fi
if [ -f "$HOOK_DEF" ]; then
  if [ "$(jq -r '.enabled // false' "$HOOK_DEF" 2>/dev/null)" = "true" ]; then
    ok "hook $HOOK_ID 已注册并启用"
  else
    fail "hook $HOOK_ID 注册了但没启用：消息只会躺在 inbox 里没人唤醒，让 Muse 启用它"
  fi
else
  fail "hook $HOOK_ID 没注册（$HOOK_DEF 不存在）：只有脚本不会唤醒任何人，按 SKILL.md 用 hooks.add 注册"
fi

# ---- 积压 ----
count_older() { find "$1" -maxdepth 1 -name "$2" -mmin "+$3" 2>/dev/null | wc -l; }
if [ -d inbox ]; then
  c="$(count_older inbox '*.json' 1)"
  [ "$c" -gt 0 ] && fail "inbox 有 $c 条消息超过 1 分钟没被 hook 认领：hook 没在跑或没启用"
  c="$(count_older inbox '*.json.claimed' 10)"
  [ "$c" -gt 0 ] && warn "有 $c 条消息认领超过 10 分钟还没处理完（worker 慢或崩了；超过回复超时会提醒用户）"
fi
if [ -d outbox ]; then
  c="$(count_older outbox '*.json' 3)"
  [ "$c" -gt 0 ] && fail "outbox 有 $c 条回复超过 3 分钟没发出：daemon 投递卡住，看 daemon.log"
fi
if [ -d failed ]; then
  c="$(find failed -maxdepth 1 -name '*.reason.json' -mmin -1440 2>/dev/null | wc -l)"
  [ "$c" -gt 0 ] && warn "最近 24 小时有 $c 条回复发送失败（failed/*.reason.json 里有原因）"
fi
[ "$FAILS" -eq 0 ] && [ "$WARNS" -eq 0 ] && ok "没发现问题"

echo
echo "结果：$FAILS 项必须修，$WARNS 项提醒。"
echo "最终验收：关掉 Muse 网页，只用手机飞书给机器人发一条消息，收到回复才算真的通了。"
[ "$FAILS" -eq 0 ]
