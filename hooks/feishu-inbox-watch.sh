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
#   - 唤醒时：按 messageId 把 {summary, turns, compress_needed, ctx_key} 放进 payload 的 recent_context
# 限制：只按字数，不按轮数。超过 MAX_CHARS 时让 worker 压缩；worker 没压缩、涨到 2×MAX_CHARS
#   时脚本兜底从最旧的开始丢。单条超长截断到 2000 字。所有 state 原子写入；同一时刻只跑一个实例。
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

NAME="feishu"                                   # 状态文件前缀
BRIDGE_ROOT="$HOME/workspace/muse-feishu-bridge" # 桥接部署目录：装在别处就改这一行
INBOX="$BRIDGE_ROOT/inbox"
CTX_DIR="$HOME/hooks/state"
STALE_SECS=1500        # 认领有效期：必须大于回复超时（config.json replyTimeoutMin=20 分钟）
MAX_CHARS=30000        # 每个会话的上下文字数上限（含摘要）。Muse Spark 1.3 窗口 1M token，3 万字约占 3%
CTX_TTL_DAYS=7         # 多少天没动过的历史删掉
ARCHIVE_TTL_DAYS=30    # /clear 归档保留多少天

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

mode, name, ctx_dir, bridge, max_chars = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
args = sys.argv[6:]
PENDING = os.path.join(ctx_dir, name + "-pending.json")
PENDING_TTL = 24 * 3600   # 一天还没等到回复（失败/作废/worker 一直崩）就放弃
ITEM_MAX = 2000           # 单条截断
SUMMARY_MAX = 3000        # 摘要上限（worker 写超了也截断）
MENTION_RE = re.compile(r"^\s*(@[^@\n]*?（你）|@\S+)\s*")

def is_clear(text):
    """整条消息就是 /clear（前面可以带 @机器人）；句子里顺带提到 /clear 不算"""
    t = text or ""
    while True:
        t2 = MENTION_RE.sub("", t, count=1)
        if t2 == t:
            break
        t = t2
    return t.strip().lower() == "/clear"

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

def size(ctx):
    return len(ctx["summary"]) + sum(len(t.get("user", "")) + len(t.get("assistant", "")) for t in ctx["turns"])

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
        if not os.path.exists(sent_f):
            gone = any(os.path.exists(os.path.join(bridge, d, mid + ".json")) for d in ("failed", "expired"))
            if gone or now - info.get("ts", now) > PENDING_TTL:
                del pending[mid]; changed = True
            continue
        reply = load(sent_f)
        if not reply:      # 读失败（理论上 sent/ 是原子归档的），下轮再试
            continue
        del pending[mid]; changed = True
        if info.get("skip"):
            continue
        chat = info.get("chatId") or "unknown"
        key = key_of(chat)
        ctx = load_ctx(key)
        ctx["chatId"] = chat
        ctx["turns"].append({"seq": ctx["next_seq"], "user": info.get("text", ""),
                             "assistant": (reply.get("text") or "")[:ITEM_MAX], "ts": int(now)})
        ctx["next_seq"] += 1
        # 兜底：worker 一直没压缩、涨到 2 倍上限时，从最旧的开始丢到上限以内
        if size(ctx) > 2 * max_chars:
            while len(ctx["turns"]) > 1 and size(ctx) > max_chars:
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
        if is_clear(d.get("text")):
            do_clear(pending, chat, mid)
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
        need = (size(ctx) > max_chars and key not in flagged and len(ctx["turns"]) > 1
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
    print(json.dumps(out, ensure_ascii=False))
PYEOF
py() { python3 -c "$PYLIB" "$1" "$NAME" "$CTX_DIR" "$BRIDGE_ROOT" "$MAX_CHARS" "${@:2}"; }

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
find "$CTX_DIR" -maxdepth 1 -name "$NAME-ctx-*.json" ! -name "*-archived-*" -mtime +$CTX_TTL_DAYS -delete 2>/dev/null || true
find "$CTX_DIR" -maxdepth 1 -name "$NAME-ctx-*-archived-*.json" -mtime +$ARCHIVE_TTL_DAYS -delete 2>/dev/null || true
find "$CTX_DIR" -maxdepth 1 -name "$NAME-*.tmp.*" -mmin +10 -delete 2>/dev/null || true

count="${#claimed[@]}"
if [ "$count" -eq 0 ]; then
  silent "inbox empty" '{}'
fi

# ---- 步骤 4：组装 recent_context ----
ids="$(printf '%s\n' "${claimed[@]}" | jq -R . | jq -s -c .)"
ctx_json="$(py context "${claimed[@]}" 2>/dev/null || true)"
# python 出错时退回空上下文，保证 wake 照常发出
if ! printf '%s' "$ctx_json" | jq -e 'type == "object"' >/dev/null 2>&1; then ctx_json='{}'; fi

# 轮询本身不写日志（5 秒一次会刷屏）；wake 由运行时记录。
wake "$NAME inbox 有 $count 条待处理消息" "{\"count\":$count,\"message_ids\":$ids,\"max_chars\":$MAX_CHARS,\"recent_context\":$ctx_json}"
