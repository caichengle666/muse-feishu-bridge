#!/bin/bash
# muse-feishu daemon 保活：健康则静默退出；不健康（进程不在 / 心跳停滞 / 断线超过宽限）则（杀掉并）拉起。
# 同一个飞书应用只应有一条长连接：keepalive 用 flock（缺失时退回 mkdir 锁）防止并发拉起，
# daemon 自己再用 O_EXCL 的 daemon.lock 保证单实例。
#
# 用法：
#   bash keepalive.sh            # 检查并在需要时拉起
#   bash keepalive.sh --status   # 只检查：健康 exit 0，不健康 exit 1（不做任何动作）
#   bash keepalive.sh --install-cron    # 装好 cron（每 5 分钟 + 开机拉起），可重复执行
#   bash keepalive.sh --uninstall-cron
#   source keepalive.sh          # 只定义函数、不执行（测试用）
#
# 环境变量（都可选）：
#   MUSE_FEISHU_ROOT        运行目录，默认本脚本所在目录（一律 realpath 规范化）
#   MUSE_FEISHU_GRACE_SEC   刚断线（connected:false）的宽限秒数，默认 90
#   MUSE_FEISHU_START_GRACE_SEC  新进程的宽限秒数（给建连机会），默认同 GRACE
#   MUSE_FEISHU_STALE_SEC   心跳多久不更新算停滞，默认 90
#   MUSE_FEISHU_WAIT_SEC    拉起后等待"已连接"心跳的秒数，默认 45
#   MUSE_FEISHU_FLOCK_BIN   flock 路径，默认 command -v flock；设为空串则视为没有 flock（走 mkdir 锁）
#   NODE_BIN               node 路径，默认 command -v node
#
# 进程身份：daemon.pid 一行 `<pid> <starttime> <token>`，heartbeat.json 也带 token。
# 只有 pid 存在 且 /proc/<pid>/stat 的 starttime 与记录相同 且 心跳 token 与 pid 文件相同
# 且 命令行里的 daemon.js（相对路径按 /proc/<pid>/cwd 解析后 realpath）就是 $ROOT/dist/daemon.js，
# 才认为"是我们的 daemon"，也只有这时才会去 kill 它——pid 被复用时绝不误杀无关进程。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_RAW="${MUSE_FEISHU_ROOT:-$SCRIPT_DIR}"
ROOT="$(realpath -m -- "$ROOT_RAW" 2>/dev/null || readlink -f -- "$ROOT_RAW" 2>/dev/null || echo "$ROOT_RAW")"
LOG="$ROOT/daemon.log"
PIDFILE="$ROOT/daemon.pid"
HEARTBEAT="$ROOT/heartbeat.json"
DAEMON_JS="$ROOT/dist/daemon.js"
DAEMON_JS_REAL="$(realpath -m -- "$DAEMON_JS" 2>/dev/null || echo "$DAEMON_JS")"
GRACE="${MUSE_FEISHU_GRACE_SEC:-90}"
START_GRACE="${MUSE_FEISHU_START_GRACE_SEC:-$GRACE}"
STALE="${MUSE_FEISHU_STALE_SEC:-90}"
WAIT_SEC="${MUSE_FEISHU_WAIT_SEC:-45}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
FLOCK_BIN="${MUSE_FEISHU_FLOCK_BIN-$(command -v flock || true)}"

log() { echo "[$(date -u '+%FT%TZ')] keepalive: $*" >> "$LOG"; }

# /proc/<pid>/stat 第 22 字段（starttime，自开机的时钟滴答数）。
# 格式 `pid (comm) state ...`，comm 可含空格和 ')'，所以截到【最后一个】')' 之后再切分：
# 剩余部分第 1 个字段是总字段 3（state），总字段 N = 剩余第 N-2 个 = 数组下标 N-3，
# 所以第 22 字段 = 下标 19（即 `set -- $rest` 时的 ${20}）。
proc_starttime() {
  local pid="$1" stat rest
  local -a f
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  [ -n "$stat" ] || return 1
  rest="${stat##*)}"
  read -r -a f <<< "$rest"
  [ "${#f[@]}" -ge 20 ] || return 1
  [[ "${f[19]}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${f[19]}"
}

# 读 pid 文件 → PF_PID PF_ST PF_TOK；格式不对返回 1
read_pidfile() {
  PF_PID="" PF_ST="" PF_TOK=""
  [ -f "$PIDFILE" ] || return 1
  read -r PF_PID PF_ST PF_TOK _ < "$PIDFILE" || [ -n "$PF_PID" ] || return 1
  [[ "$PF_PID" =~ ^[0-9]+$ ]] && [ "$PF_PID" -gt 1 ] || return 1
  [[ "$PF_ST" =~ ^[0-9]+$ ]] || return 1
  [[ "$PF_TOK" =~ ^[A-Za-z0-9]{8,128}$ ]] || return 1
}

# 进程命令行里 daemon.js 的规范路径：相对路径按 realpath(/proc/<pid>/cwd) 解析，再 realpath
daemon_script_of() {
  local pid="$1" cwd a script=""
  local -a args
  [ -r "/proc/$pid/cmdline" ] || return 1
  mapfile -d '' args < "/proc/$pid/cmdline" 2>/dev/null || return 1
  for a in "${args[@]}"; do
    case "$a" in */daemon.js|daemon.js) script="$a"; break ;; esac
  done
  [ -n "$script" ] || return 1
  if [ "${script#/}" = "$script" ]; then
    cwd="$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null)" || return 1
    [ -n "$cwd" ] || return 1
    script="$cwd/$script"
  fi
  realpath -m -- "$script" 2>/dev/null
}

# pid 存在 + starttime 与记录相同 + 命令行脚本就是本 ROOT 的 dist/daemon.js
is_our_daemon() {
  local pid="$1" st="$2" cur script
  [ -n "$pid" ] && [ -n "$st" ] || return 1
  [ -d "/proc/$pid" ] || return 1
  cur="$(proc_starttime "$pid")" || return 1
  [ "$cur" = "$st" ] || return 1
  script="$(daemon_script_of "$pid")" || return 1
  [ "$script" = "$DAEMON_JS_REAL" ]
}

# 输出 "<pid> <ts秒> <connected 0/1> <token|->"；读不到输出 "0 0 0 -"
read_heartbeat() {
  [ -f "$HEARTBEAT" ] && [ -n "$NODE_BIN" ] || { echo "0 0 0 -"; return; }
  "$NODE_BIN" -e '
    try {
      const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const tok = typeof h.token === "string" && /^[A-Za-z0-9]{8,128}$/.test(h.token) ? h.token : "-";
      console.log(`${h.pid|0} ${Math.floor((h.ts||0)/1000)} ${h.connected===true?1:0} ${tok}`);
    } catch { console.log("0 0 0 -"); }
  ' "$HEARTBEAT" 2>/dev/null || echo "0 0 0 -"
}

# 身份完全核实（pid + starttime + 心跳 token + ROOT 脚本）。成功时设置 ID_PID ID_ST 与 HB_*。
identity_verified() {
  ID_PID="" ID_ST=""
  read_pidfile || return 1
  is_our_daemon "$PF_PID" "$PF_ST" || return 1
  read -r HB_PID HB_TS HB_CONN HB_TOK <<< "$(read_heartbeat)"
  [ "$HB_PID" = "$PF_PID" ] || return 1
  [ "$HB_TOK" != "-" ] && [ "$HB_TOK" = "$PF_TOK" ] || return 1
  ID_PID="$PF_PID" ID_ST="$PF_ST"
}

# 健康 = 身份核实 且：
#   (a) 进程年龄 < START_GRACE（刚启动，给建连机会），或
#   (b) connected:true 且心跳 < STALE 秒，或
#   (c) connected:false 但断线时刻距今 < GRACE（SDK 正在自动重连）
is_healthy() {
  local etimes now
  identity_verified || return 1
  etimes="$(ps -o etimes= -p "$ID_PID" 2>/dev/null | tr -d ' ')"
  if [ -n "$etimes" ] && [ "$etimes" -lt "$START_GRACE" ] 2>/dev/null; then
    return 0
  fi
  now="$(date +%s)"
  [ "$HB_TS" -gt 0 ] 2>/dev/null || return 1
  if [ "$HB_CONN" = "1" ]; then
    [ $((now - HB_TS)) -lt "$STALE" ]
  else
    [ $((now - HB_TS)) -lt "$GRACE" ]
  fi
}

KA_MKDIR_LOCK=""
# keepalive 自身的并发锁：优先 flock；没有 flock 时警告并退回 mkdir 锁（目录里记 pid + starttime，持有者死了可回收）
acquire_ka_lock() {
  if [ -n "$FLOCK_BIN" ] && [ -x "$FLOCK_BIN" ]; then
    exec 9>"$ROOT/.keepalive.lock"
    if ! "$FLOCK_BIN" -n 9; then
      log "另一个 keepalive 正在运行（flock 未获取 $ROOT/.keepalive.lock），本次跳过"
      return 1
    fi
    return 0
  fi
  log "警告：未找到 flock，退回 mkdir 锁（$ROOT/.keepalive.lock.d）"
  local d="$ROOT/.keepalive.lock.d" op ost
  if ! mkdir "$d" 2>/dev/null; then
    read -r op ost _ < "$d/owner" 2>/dev/null || true
    if [ -n "${op:-}" ] && [ "$(proc_starttime "$op" 2>/dev/null)" = "${ost:-x}" ]; then
      log "另一个 keepalive（pid $op）持有 mkdir 锁，本次跳过"
      return 1
    fi
    # 陈旧锁：先 rename 拿走（原子，只有一个竞争者成功），再重新 mkdir
    mv -- "$d" "$d.stale.$$" 2>/dev/null && rm -rf -- "$d.stale.$$"
    if ! mkdir "$d" 2>/dev/null; then
      log "mkdir 锁未获取（竞争失败），本次跳过"
      return 1
    fi
    log "回收了陈旧的 mkdir 锁"
  fi
  echo "$$ $(proc_starttime $$ 2>/dev/null || echo 0)" > "$d/owner"
  KA_MKDIR_LOCK="$d"
  trap '[ -n "$KA_MKDIR_LOCK" ] && rm -rf -- "$KA_MKDIR_LOCK"' EXIT
  return 0
}

# 被 source 时只定义函数（测试用）
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0 2>/dev/null || true
fi

# 安装 / 卸载 cron（幂等：按标记行替换，不动用户的其他条目）
if [ "${1:-}" = "--install-cron" ] || [ "${1:-}" = "--uninstall-cron" ]; then
  command -v crontab >/dev/null 2>&1 || { echo "未找到 crontab，请先安装 cron（如 apt-get install cron）"; exit 2; }
  MARK="# muse-feishu-bridge keepalive ($ROOT)"
  CUR="$(crontab -l 2>/dev/null | grep -vF "$MARK" || true)"
  if [ "$1" = "--uninstall-cron" ]; then
    printf '%s\n' "$CUR" | sed '/^$/d' | crontab - && echo "已移除 cron 条目"; exit $?
  fi
  KA="/bin/bash $(printf '%q' "$ROOT/keepalive.sh") >/dev/null 2>&1"
  {
    printf '%s\n' "$CUR" | sed '/^$/d'
    echo "*/5 * * * * $KA $MARK"
    echo "@reboot sleep 30 && $KA $MARK"
  } | crontab - || exit 1
  echo "已安装 cron：每 5 分钟检查一次 + 开机 30 秒后拉起"
  crontab -l | grep -F "$MARK"
  pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1 || echo "警告：cron 服务似乎没在运行（service cron start）"
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  if is_healthy; then echo "healthy"; exit 0; fi
  echo "unhealthy"; exit 1
fi

mkdir -p "$ROOT" 2>/dev/null || true

acquire_ka_lock || exit 0

if is_healthy; then
  exit 0
fi

# 只有身份完全核实（pid + starttime + 心跳 token + ROOT 脚本）的进程才杀：假死 / 长时间断线
if identity_verified; then
  OLD_PID="$ID_PID" OLD_ST="$ID_ST"
  log "进程 $OLD_PID 存在但不健康（心跳停滞或未连接），杀掉重拉"
  kill "$OLD_PID" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    is_our_daemon "$OLD_PID" "$OLD_ST" || break
    sleep 1
  done
  if is_our_daemon "$OLD_PID" "$OLD_ST"; then
    kill -9 "$OLD_PID" 2>/dev/null
    sleep 1
  fi
elif read_pidfile && [ -d "/proc/$PF_PID" ]; then
  log "pid 文件指向的进程 $PF_PID 身份不符（启动时间/令牌/ROOT 不匹配，可能是 pid 复用），不杀它"
fi

[ -n "$NODE_BIN" ] || { log "找不到 node"; exit 1; }
[ -f "$DAEMON_JS" ] || { log "缺少 $DAEMON_JS，请先 npm run build"; exit 1; }
cd "$ROOT" || { log "无法进入 $ROOT"; exit 1; }

log "daemon 不健康或不存在，拉起…"
# setsid 彻底脱离当前会话；用绝对路径启动（pid 文件与单实例锁由 daemon 自己写）
MUSE_FEISHU_ROOT="$ROOT" setsid "$NODE_BIN" "$DAEMON_JS" >> "$LOG" 2>&1 < /dev/null 9>&- &

# 成功判据：身份核实（pid 文件 + starttime + 心跳 token）且 connected:true
for _ in $(seq 1 "$WAIT_SEC"); do
  sleep 1
  identity_verified || continue
  if [ "$HB_CONN" = "1" ]; then
    log "拉起成功（pid $ID_PID），长连接已就绪"
    exit 0
  fi
done
log "拉起后 ${WAIT_SEC}s 内未见已连接心跳，见 daemon.log / debug.log"
exit 1
