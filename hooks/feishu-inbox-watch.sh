#!/usr/bin/env bash
# feishu-inbox-watch.sh — 轮询飞书桥接的 inbox/，有新消息就唤醒助手处理，并维护多轮上下文。
#
# 原子认领：mv inbox/<id>.json → inbox/<id>.json.claimed（mv 原子，同一时刻只有一个轮询抢得到）。
# worker 读 .claimed，处理完删除；worker 崩溃时，超过认领有效期会重新认领。
#
# 上下文（只由本脚本写，worker 从不直接改历史文件，避免两边同时写互相覆盖）：
#   ~/hooks/state/<NAME>-ctx-<key>.json     {chatId, summary, turns:[{seq,user,assistant,ts}], next_seq, updated}
#   ~/hooks/state/<NAME>-pending.json       已认领、还没收割的消息 {messageId: {chatId, text, ts, at, skip}}
# worker 只会留下两种"请求文件"，由本脚本下一轮合并：
#   <NAME>-ctx-<key>.summary.json  {summary, upto_seq}  把 seq ≤ upto_seq 的旧轮压缩进 summary
#   <NAME>-ctx-<key>.clear.json    {messageId}           用户要换话题：归档历史、这条不入新历史
# 流程：
#   - 认领时：从 .claimed 读出 chatId 和用户原文记入 pending；/clear 在这一步直接归档
#   - 收割时：先处理 clear / summary 请求，再看 pending 里哪些消息的回复已归档到 sent/<id>.json
#     （daemon 发送成功才归档，里面 text 就是用户实际看到的回复），追加成一轮
#   - /compact [重点]：手动压缩。这条不进历史；上下文带 compact=true + compress_needed=true（不管多大），worker 把
#     较早的轮压成摘要（保留最近 2 轮原文），照常写 summary 请求文件由本脚本合并；还在处理中的任务不受影响
#   - /stop 由 daemon 秒级处理（不进 inbox）：被中断的消息移到 expired/ 并留 expired/<id>.stopped，
#     收割时记成"被中断"的一轮；之后第一条新消息带 after_stop，提醒 worker 按新指令做、别接着做旧任务
#   - 唤醒时：按 messageId 把 {summary, turns, compress_needed, ctx_key} 写进上下文文件，payload 的 context_file 指向它
# 限制：只按大小（UTF-8 字节），不按轮数。超过 MAX_BYTES 时让 worker 压缩；worker 没压缩、涨到 2×MAX_BYTES
#   时脚本兜底从最旧的开始丢。单条超长截断到 8000 字。
# 上下文太大不适合塞进 wake 参数，写到 ~/hooks/state/<NAME>-wake-*.json，payload 只带 context_file 路径。所有 state 原子写入；同一时刻只跑一个实例。
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

NAME="feishu"                                   # 状态文件前缀
BRIDGE_ROOT="$HOME/workspace/muse-feishu-bridge" # 桥接部署目录：装在别处就改这一行
INBOX="$BRIDGE_ROOT/inbox"
CTX_DIR="$HOME/hooks/state"
STALE_SECS=1500        # 认领有效期：必须大于回复超时（config.json replyTimeoutMin=20 分钟）
MAX_BYTES="${CTX_MAX_BYTES:-524288}"  # 每个会话的上下文上限：512KB（UTF-8 字节，含摘要），超了让 worker 压缩
                                      # Muse Spark 1.3 窗口 1,048,576 token；512KB 中文约 17 万字
CTX_TTL_DAYS=7         # 多少天没动过的历史删掉
ARCHIVE_TTL_DAYS=30    # /clear 归档保留多少天
HEALTH_STALE_SECS=600  # 心跳多久没更新算桥接异常（比 keepalive 的 cron 5 分钟长，先给它自愈的机会）

mkdir -p "$CTX_DIR"
PENDING="$CTX_DIR/$NAME-pending.json"
# 兼容旧版文件名（旧名会和 chatId 恰好叫 pending 的会话撞名）
if [ -f "$CTX_DIR/$NAME-ctx-pending.json" ] && [ ! -f "$PENDING" ]; then
  mv "$CTX_DIR/$NAME-ctx-pending.json" "$PENDING" 2>/dev/null || true
fi

# 同一时刻只跑一个实例：拿不到锁就这轮跳过（inbox 文件还在，下一轮再认领）
if command -v flock >/dev/null 2>&1; then
  exec 9>"$CTX_DIR/.$NAME-ctx.lock"
  flock -n 9 || silent "another poll running" '{}'
fi

read -r -d '' PYLIB <<'PYEOF' || true
import hashlib, json, os, re, sys, time

mode, name, ctx_dir, bridge, max_bytes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
args = sys.argv[6:]
PENDING = os.path.join(ctx_dir, name + "-pending.json")
PENDING_TTL = 24 * 3600   # 一天还没等到回复（失败/作废/worker 一直崩）就放弃
ITEM_MAX = 8000           # 单条截断（字）
SUMMARY_MAX = 6000        # 摘要上限（字，worker 写超了也截断）
MENTION_RE = re.compile(r"^\s*(@[^@\n]*?（你）|@\S+)\s*")

def strip_mentions(text):
    t = text or ""
    while True:
        t2 = MENTION_RE.sub("", t, count=1)
        if t2 == t:
            return t.strip()
        t = t2

def is_clear(text):
    """整条消息就是 /clear（前面可以带 @机器人）；句子里顺带提到 /clear 不算"""
    return strip_mentions(text).lower() == "/clear"

COMPACT_RE = re.compile(r"^/compact(?:\s+([\s\S]*))?$", re.I)

def compact_cmd(text):
    """/compact [重点说明]（前面可以带 @机器人）：返回重点说明（可为空串）；不是这条命令返回 None"""
    m = COMPACT_RE.match(strip_mentions(text))
    return None if not m else (m.group(1) or "").strip()[:500]

def key_of(chat):
    chat = chat or "unknown"
    k = re.sub(r"[^A-Za-z0-9_-]", "_", chat)
    if k != chat:  # 有字符被替换时加短哈希，避免 a.b 和 a_b 撞到同一个文件
        k += "_" + hashlib.md5(chat.encode()).hexdigest()[:8]
    return k

def ctx_path(key, suffix=""):
    return os.path.join(ctx_dir, "%s-ctx-%s%s.json" % (name, key, suffix))

def load(p):
    try:
        with open(p) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}

def save_atomic(p, data):
    tmp = "%s.tmp.%d" % (p, os.getpid())
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, p)

def rm(p):
    try:
        os.remove(p)
    except FileNotFoundError:
        pass

def load_ctx(key):
    ctx = load(ctx_path(key))
    turns = [t for t in ctx.get("turns", []) if isinstance(t, dict)]
    seq = 0
    for t in turns:  # 旧格式没有 seq：按顺序补上
        if not isinstance(t.get("seq"), int):
            t["seq"] = seq + 1
        seq = max(seq, t["seq"])
    ctx["turns"] = turns
    ctx["summary"] = ctx.get("summary") if isinstance(ctx.get("summary"), str) else ""
    ctx["next_seq"] = max(int(ctx.get("next_seq") or 0), seq + 1)
    return ctx

def blen(s):
    return len((s or "").encode("utf-8"))

def size(ctx):  # UTF-8 字节
    return blen(ctx["summary"]) + sum(blen(t.get("user")) + blen(t.get("assistant")) for t in ctx["turns"])

def do_clear(pending, chat, mid):
    """归档该会话历史；这条以及同会话更早的未完成消息都不进新历史。"""
    key = key_of(chat)
    p = ctx_path(key)
    if os.path.exists(p):
        os.replace(p, ctx_path(key, "-archived-%d" % int(time.time())))
    rm(ctx_path(key, ".summary"))
    at = pending.get(mid, {}).get("at", "")
    for k, v in pending.items():
        if v.get("chatId") == chat and (k == mid or (at and v.get("at", "") <= at)):
            v["skip"] = True

def stop_info(chat):
    """daemon 写的 <bridge>/stop/<会话>.json（文件名规则与 key_of 相同）"""
    return load(os.path.join(bridge, "stop", key_of(chat) + ".json"))

def user_text(d):
    text = (d.get("text") or "").strip()
    notes = []
    for a in d.get("attachments") or []:
        if isinstance(a, dict):
            notes.append(a.get("fileName") or a.get("kind") or "附件")
    for k, label in (("imagePath", "图片"), ("filePath", "文件"), ("videoPath", "视频")):
        if d.get(k):
            notes.append(os.path.basename(str(d[k])) or label)
    if notes:
        text = (text + " " if text else "") + "[附件: %s]" % ", ".join(notes)
    return text[:ITEM_MAX]

pending = load(PENDING)

if mode == "harvest":
    changed = False
    # 1) worker 留下的换话题请求
    for fn in sorted(os.listdir(ctx_dir)):
        if not (fn.startswith(name + "-ctx-") and fn.endswith(".clear.json")):
            continue
        p = os.path.join(ctx_dir, fn)
        req = load(p)
        key = fn[len(name + "-ctx-"):-len(".clear.json")]
        mid = str(req.get("messageId", ""))
        chat = pending.get(mid, {}).get("chatId") or load_ctx(key).get("chatId")
        if chat and key_of(chat) == key:
            do_clear(pending, chat, mid)
        elif os.path.exists(ctx_path(key)):
            os.replace(ctx_path(key), ctx_path(key, "-archived-%d" % int(time.time())))
        rm(p)
        changed = True
    # 2) worker 留下的压缩结果
    for fn in sorted(os.listdir(ctx_dir)):
        if not (fn.startswith(name + "-ctx-") and fn.endswith(".summary.json")):
            continue
        p = os.path.join(ctx_dir, fn)
        req = load(p)
        rm(p)
        key = fn[len(name + "-ctx-"):-len(".summary.json")]
        if not os.path.exists(ctx_path(key)):
            continue
        summary, upto = req.get("summary"), req.get("upto_seq")
        if not isinstance(summary, str) or not isinstance(upto, int):
            continue
        ctx = load_ctx(key)
        ctx["turns"] = [t for t in ctx["turns"] if t["seq"] > upto]
        ctx["summary"] = summary.strip()[:SUMMARY_MAX]
        ctx["updated"] = int(time.time())
        save_atomic(ctx_path(key), ctx)
    # 3) 收割已发出的回复
    now = time.time()
    for mid, info in list(pending.items()):
        sent_f = os.path.join(bridge, "sent", mid + ".json")
        if os.path.exists(os.path.join(bridge, "expired", mid + ".stopped")):
            # 用户 /stop 中断了这条：记成一轮，让后面的 worker 知道它没做完
            del pending[mid]; changed = True
            if info.get("skip") or info.get("compact") is not None:
                continue
            chat = info.get("chatId") or "unknown"
            key = key_of(chat)
            ctx = load_ctx(key)
            ctx["chatId"] = chat
            ctx["turns"].append({"seq": ctx["next_seq"], "user": info.get("text", ""),
                                 "assistant": "（用户发 /stop 中断了这条，回复没有发出；中断前可能已执行了一部分）",
                                 "ts": int(now)})
            ctx["next_seq"] += 1
            ctx["updated"] = int(now)
            save_atomic(ctx_path(key), ctx)
            continue
        if not os.path.exists(sent_f):
            gone = any(os.path.exists(os.path.join(bridge, d, mid + ".json")) for d in ("failed", "expired"))
            if gone or now - info.get("ts", now) > PENDING_TTL:
                del pending[mid]; changed = True
            continue
        reply = load(sent_f)
        if not reply:      # 读失败（理论上 sent/ 是原子归档的），下轮再试
            continue
        del pending[mid]; changed = True
        if info.get("skip") or info.get("compact") is not None:   # /compact 本身不进历史
            continue
        chat = info.get("chatId") or "unknown"
        key = key_of(chat)
        ctx = load_ctx(key)
        ctx["chatId"] = chat
        ctx["turns"].append({"seq": ctx["next_seq"], "user": info.get("text", ""),
                             "assistant": (reply.get("text") or "")[:ITEM_MAX], "ts": int(now)})
        ctx["next_seq"] += 1
        # 兜底：worker 一直没压缩、涨到 2 倍上限时，从最旧的开始丢到上限以内
        if size(ctx) > 2 * max_bytes:
            while len(ctx["turns"]) > 1 and size(ctx) > max_bytes:
                ctx["turns"].pop(0)
            if "已丢弃" not in ctx["summary"]:
                ctx["summary"] = (ctx["summary"] + "\n（更早的若干轮未及时压缩，已丢弃）").strip()
        ctx["updated"] = int(now)
        save_atomic(ctx_path(key), ctx)
    if changed:
        save_atomic(PENDING, pending)

elif mode == "record":
    inbox = os.path.join(bridge, "inbox")
    for mid in args:
        if not mid or mid in pending:
            continue
        d = load(os.path.join(inbox, mid + ".json.claimed"))
        if not d:
            continue
        chat = str(d.get("chatId") or "unknown")
        pending[mid] = {"chatId": chat, "text": user_text(d), "ts": int(time.time()), "at": str(d.get("ts", ""))}
        # /stop 之后的第一条：标 after_stop（同一次 /stop 只标一次，记在历史文件的 stop_seen）
        st = stop_info(chat)
        st_at = str(st.get("at") or "")
        if st_at and st_at < pending[mid]["at"]:
            key = key_of(chat)
            ctx = load_ctx(key)
            if st_at > str(ctx.get("stop_seen") or ""):
                pending[mid]["after_stop"] = st_at
                ctx["chatId"] = chat
                ctx["stop_seen"] = st_at
                save_atomic(ctx_path(key), ctx)
        if is_clear(d.get("text")):
            do_clear(pending, chat, mid)
        else:
            c = compact_cmd(d.get("text"))
            if c is not None:
                pending[mid]["compact"] = c
    save_atomic(PENDING, pending)

elif mode == "context":
    out, flagged = {}, set()
    # 同一会话一次 wake 里只让最新那条负责压缩
    order = sorted(args, key=lambda m: pending.get(m, {}).get("at", ""), reverse=True)
    for mid in order:
        me = pending.get(mid, {})
        chat = me.get("chatId") or "unknown"
        key = key_of(chat)
        if me.get("skip"):
            out[mid] = {"ctx_key": key, "cleared": True, "summary": "", "turns": [], "compress_needed": False}
            continue
        ctx = load_ctx(key)
        compact = me.get("compact")
        if compact is not None:
            # 用户手动 /compact：不管多大都压（最新一条负责；同一 wake 里别的消息不再重复压）
            need = key not in flagged and (len(ctx["turns"]) > 0 or bool(ctx["summary"]))
        else:
            need = (size(ctx) > max_bytes and key not in flagged and len(ctx["turns"]) > 1
                    and not os.path.exists(ctx_path(key, ".summary")))
        if need:
            flagged.add(key)
        turns = [{"seq": t["seq"], "user": t.get("user", ""), "assistant": t.get("assistant", "")} for t in ctx["turns"]]
        # 同会话里比这条早、还没回完的（用户连发几条时）
        mine = me.get("at", "")
        for at, k in sorted((v.get("at", ""), k) for k, v in pending.items()
                            if k != mid and v.get("chatId") == chat and not v.get("skip") and v.get("at", "") < mine):
            turns.append({"user": pending[k].get("text", ""), "assistant": "（这条还在处理中，回复尚未发出）"})
        out[mid] = {"ctx_key": key, "summary": ctx["summary"], "turns": turns, "compress_needed": need}
        if me.get("after_stop"):
            out[mid]["after_stop"] = True
        if compact is not None:
            out[mid]["compact"] = True
            out[mid]["compact_hint"] = compact
            out[mid]["size_bytes"] = size(ctx)
    p = os.path.join(ctx_dir, "%s-wake-%d-%d.json" % (name, int(time.time() * 1000), os.getpid()))
    save_atomic(p, out)
    print(p)
PYEOF
py() { python3 -c "$PYLIB" "$1" "$NAME" "$CTX_DIR" "$BRIDGE_ROOT" "$MAX_BYTES" "${@:2}"; }

# ---- 步骤 0：合并 worker 的压缩/换话题请求，收割已发出的回复 ----
if grep -q '"' "$PENDING" 2>/dev/null || compgen -G "$CTX_DIR/$NAME-ctx-*.summary.json" >/dev/null || compgen -G "$CTX_DIR/$NAME-ctx-*.clear.json" >/dev/null; then
  py harvest || true
fi

# ---- 步骤 1：认领新消息 ----
claimed=( )
if [ -d "$INBOX" ]; then
  shopt -s nullglob
  # 1a. *.json 不会匹配 *.json.claimed；daemon 原子写入，不会有半截文件
  for f in "$INBOX"/*.json; do
    id="$(basename "$f" .json)"
    if mv "$f" "$INBOX/$id.json.claimed" 2>/dev/null; then
      claimed+=("$id")
    fi
  done
  # 1b. 回收过期认领（worker 可能崩了）
  now="$(date +%s)"
  for f in "$INBOX"/*.json.claimed; do
    mtime="$(stat -c %Y "$f" 2>/dev/null || echo "$now")"
    if [ $((now - mtime)) -gt "$STALE_SECS" ]; then
      id="$(basename "$f" .json.claimed)"
      already=0
      for c in "${claimed[@]}"; do [ "$c" = "$id" ] && already=1 && break; done
      if [ "$already" -eq 0 ] && touch "$f" 2>/dev/null; then
        claimed+=("$id")   # touch 重置认领时间，免得下一轮又被当成过期
      fi
    fi
  done
  shopt -u nullglob
fi

# ---- 步骤 2：记入 pending（/clear 在这里直接归档） ----
if [ "${#claimed[@]}" -gt 0 ]; then
  py record "${claimed[@]}" || true
fi

# ---- 步骤 3：清理过期历史（.summary/.clear 请求文件也一起） ----
find "$CTX_DIR" -maxdepth 1 -name "$NAME-wake-*.json" -mmin +1440 -delete 2>/dev/null || true
find "$CTX_DIR" -maxdepth 1 -name "$NAME-ctx-*.json" ! -name "*-archived-*" -mtime +$CTX_TTL_DAYS -delete 2>/dev/null || true
find "$CTX_DIR" -maxdepth 1 -name "$NAME-ctx-*-archived-*.json" -mtime +$ARCHIVE_TTL_DAYS -delete 2>/dev/null || true
find "$CTX_DIR" -maxdepth 1 -name "$NAME-*.tmp.*" -mmin +10 -delete 2>/dev/null || true

count="${#claimed[@]}"
if [ "$count" -eq 0 ]; then
  # ---- 没新消息时顺便看桥接是否活着：daemon 挂了/断线时 hook 只会一直"没消息"，用户发了也没人回 ----
  # 心跳 heartbeat.json 的 ts（毫秒）只在已连接时每 20~30 秒刷新；超过 HEALTH_STALE_SECS 没刷新 =
  # 进程不在、卡死或一直连不上。keepalive.sh（cron 每 5 分钟）会先自己拉起，所以阈值取 10 分钟，
  # 到这里还不好说明自愈失败了，才唤醒 worker。同一个故障只唤醒一次，之后每小时最多再提醒一次；恢复后清标记。
  HB="$BRIDGE_ROOT/heartbeat.json"
  MARK="$CTX_DIR/.$NAME-health-alerted"
  now="$(date +%s)"
  issue=""
  if [ ! -f "$HB" ]; then
    issue="没有心跳文件 heartbeat.json（daemon 可能从没启动过）"
  else
    hb_ts="$(jq -r '((.ts // 0) / 1000 | floor)' "$HB" 2>/dev/null || echo 0)"
    hb_conn="$(jq -r '.connected // false' "$HB" 2>/dev/null || echo false)"
    case "$hb_ts" in ''|*[!0-9]*) hb_ts=0 ;; esac
    age=$((now - hb_ts))
    if [ "$age" -gt "$HEALTH_STALE_SECS" ]; then
      if [ "$hb_conn" = "true" ]; then
        issue="心跳已 $((age / 60)) 分钟没更新（daemon 可能已退出或卡死）"
      else
        issue="已断线 $((age / 60)) 分钟没连上（网络/代理/凭证问题）"
      fi
    fi
  fi
  if [ -z "$issue" ]; then
    rm -f "$MARK"
    silent "inbox empty" '{}'
  fi
  if [ -f "$MARK" ] && [ $((now - $(stat -c %Y "$MARK" 2>/dev/null || echo 0))) -lt 3600 ]; then
    silent "inbox empty; unhealthy, already alerted" '{}'
  fi
  touch "$MARK"
  wake "$NAME 桥接异常：$issue" "$(jq -n -c --arg i "$issue" '{count:0,message_ids:[],health_issue:$i}')"
fi

# ---- 步骤 4：组装上下文文件 ----
ids="$(printf '%s\n' "${claimed[@]}" | jq -R . | jq -s -c .)"
ctx_file="$(py context "${claimed[@]}" 2>/dev/null || true)"
# python 出错时不带上下文，保证 wake 照常发出
if [ -n "$ctx_file" ] && [ -f "$ctx_file" ]; then ctx_ref="$(printf '%s' "$ctx_file" | jq -R .)"; else ctx_ref=null; fi

# 轮询本身不写日志（5 秒一次会刷屏）；wake 由运行时记录。
wake "$NAME inbox 有 $count 条待处理消息" "{\"count\":$count,\"message_ids\":$ids,\"max_bytes\":$MAX_BYTES,\"context_file\":$ctx_ref}"
