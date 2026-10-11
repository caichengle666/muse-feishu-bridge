#!/usr/bin/env bash
# feishu-inbox-watch.sh — 轮询飞书桥接的 inbox/，有新消息就唤醒助手处理。
#
# 原子认领：用 mv 把 inbox/<id>.json 改名为 inbox/<id>.json.claimed（mv 是原子操作，
# 同一时刻只有一个轮询能抢到），杜绝多 worker 并发抢同一条消息导致重复/丢失。
# worker 读 .claimed 文件，处理完删除它；若 worker 崩溃，超过认领有效期后重新认领。
#
# 上下文（2026-10-11 新增）：每个 chatId 维护一份滚动对话历史
#   ~/hooks/state/feishu-ctx-<chatId>.json
# 原理：
#   - 认领时：立刻从 .claimed 读出 chatId 和用户原文，记入 pending
#     （.claimed 稍后会被 worker 删掉，不记就没了）
#   - 收割时：每轮先看 pending 里哪些消息的回复已归档到 sent/<id>.json
#     （桥接 daemon 发送成功后归档，里面的 text 就是用户实际看到的回复原文），
#     把"用户原文 / 助手回复"一轮追加进该 chatId 的历史
#   - 唤醒时：把各 chatId 最近 10 轮历史按 messageId 分开塞进 payload 的
#     recent_context，worker 就有上下文了
# 约束：每 chatId 最多 10 轮、总共不超过 8000 字，单条超长截断到 2000 字；
#   所有 state 文件原子写入（写临时文件再 mv）；7 天没动过的历史文件删掉。
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

INBOX="$HOME/workspace/muse-feishu-bridge/inbox"
SENT="$HOME/workspace/muse-feishu-bridge/sent"
CTX_DIR="$HOME/hooks/state"
PENDING="$CTX_DIR/feishu-ctx-pending.json"
STALE_SECS=1500        # 认领有效期：必须大于回复超时（config.json replyTimeoutMin=20 分钟）
MAX_TURNS=10           # 每个 chatId 保留最近多少轮
MAX_CHARS=8000         # 每个 chatId 历史总字数上限
CTX_TTL_DAYS=7         # 多少天没动过的历史文件删掉
ARCHIVE_TTL_DAYS=30  # 归档的话题保留 30 天

mkdir -p "$CTX_DIR"

# ---- 步骤 0：收割已完成的回复，追加到各 chatId 的滚动历史 ----
# pending 格式：{messageId: {chatId, text}}；历史文件格式：
#   {chatId, turns: [{user, assistant, ts}], updated}
BRIDGE="$HOME/workspace/muse-feishu-bridge"
python3 - "$PENDING" "$SENT" "$CTX_DIR" "$MAX_TURNS" "$MAX_CHARS" "$BRIDGE" <<'PYEOF' || true
import json, os, re, sys, time

pending_path, sent_dir, ctx_dir = sys.argv[1], sys.argv[2], sys.argv[3]
max_turns, max_chars = int(sys.argv[4]), int(sys.argv[5])
bridge = sys.argv[6]
PENDING_TTL = 24 * 3600  # 一天还没等到回复（发送失败/过期/worker 一直崩）就放弃，防 pending 无限堆积

def safe(chat):
    return re.sub(r"[^A-Za-z0-9_-]", "_", chat or "") or "unknown"

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return {}

def save_atomic(p, data):
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, p)  # 原子替换，不会有半截文件

pending = load(pending_path)
if not pending:
    sys.exit(0)

done = []
for mid, info in list(pending.items()):
    sent_f = os.path.join(sent_dir, mid + ".json")
    if not os.path.exists(sent_f):
        # 发送失败（failed/）、超时作废（expired/）或等太久：不会再有回复，直接丢掉
        gone = any(os.path.exists(os.path.join(bridge, d, mid + ".json")) for d in ("failed", "expired"))
        if gone or time.time() - info.get("ts", time.time()) > PENDING_TTL:
            done.append(mid)
        continue
    try:
        reply = json.load(open(sent_f)).get("text", "")
    except Exception:
        continue
    if not reply:
        # 空回复（worker 决定不回复）：也算一轮，避免 pending 堆积
        reply = ""
    chat = info.get("chatId", "unknown")
    user_text = (info.get("text", "") or "")[:2000]
    reply_text = (reply or "")[:2000]
    ctx_f = os.path.join(ctx_dir, "feishu-ctx-%s.json" % safe(chat))
    ctx = load(ctx_f)
    turns = ctx.get("turns", [])
    turns.append({"user": user_text, "assistant": reply_text,
                  "ts": int(time.time())})
    # 只留最近 N 轮
    turns = turns[-max_turns:]
    # 总字数超限时从最旧的开始删（至少留 1 轮）
    total = sum(len(t["user"]) + len(t["assistant"]) for t in turns)
    while len(turns) > 1 and total > max_chars:
        t = turns.pop(0)
        total -= len(t["user"]) + len(t["assistant"])
    save_atomic(ctx_f, {"chatId": chat, "turns": turns,
                        "updated": int(time.time())})
    done.append(mid)

for mid in done:
    del pending[mid]
save_atomic(pending_path, pending)
PYEOF

# ---- 步骤 1：认领新消息（原有逻辑） ----
claimed=( )
if [ -d "$INBOX" ]; then
  shopt -s nullglob
  # 1a. 认领新消息（*.json 不会匹配到 *.json.claimed；daemon 是原子写入，不会有半截文件）
  for f in "$INBOX"/*.json; do
    id="$(basename "$f" .json)"
    if mv "$f" "$INBOX/$id.json.claimed" 2>/dev/null; then
      claimed+=("$id")
    fi
  done
  # 1b. 回收过期认领（worker 可能崩了）：移回 .json 再重新认领，保持单入口
  now="$(date +%s)"
  for f in "$INBOX"/*.json.claimed; do
    mtime="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
    if [ $((now - mtime)) -gt "$STALE_SECS" ]; then
      id="$(basename "$f" .json.claimed)"
      # 去重：已在 claimed 里的跳过
      already=0
      for c in "${claimed[@]}"; do [ "$c" = "$id" ] && already=1 && break; done
      if [ "$already" -eq 0 ]; then
        if mv "$f" "$INBOX/$id.json" 2>/dev/null && mv "$INBOX/$id.json" "$INBOX/$id.json.claimed" 2>/dev/null; then
          claimed+=("$id")
        fi
      fi
    fi
  done
  shopt -u nullglob
fi

# ---- 步骤 2：把新认领的消息记入 pending（chatId + 用户原文，供步骤 0 下次收割） ----
if [ "${#claimed[@]}" -gt 0 ]; then
  # 注意：python3 - 的程序本身从 heredoc（stdin）读，id 不能再从管道喂，只能走参数
  python3 - "$PENDING" "$INBOX" "${claimed[@]}" <<'PYEOF' || true
import json, os, sys, time
pending_path, inbox = sys.argv[1], sys.argv[2]

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return {}

pending = load(pending_path)
for mid in sys.argv[3:]:
    if not mid or mid in pending:
        continue
    try:
        d = json.load(open(os.path.join(inbox, mid + ".json.claimed")))
    except Exception:
        continue
    pending[mid] = {
        "chatId": d.get("chatId", "unknown"),
        "text": (d.get("text", "") or "")[:2000],
        "ts": int(time.time()),
        "at": d.get("ts", ""),  # 消息本身的时间（ISO），用来排先后
    }
tmp = pending_path + ".tmp"
with open(tmp, "w") as f:
    json.dump(pending, f, ensure_ascii=False)
os.replace(tmp, pending_path)
PYEOF
fi

# ---- 步骤 3：清理 7 天没动过的历史文件 ----
find "$CTX_DIR" -maxdepth 1 -name "feishu-ctx-*.json" ! -name "feishu-ctx-pending.json" ! -name "feishu-ctx-*-archived-*.json" -mtime +$CTX_TTL_DAYS -delete 2>/dev/null || true
find "$CTX_DIR" -maxdepth 1 -name "feishu-ctx-*-archived-*.json" -mtime +$ARCHIVE_TTL_DAYS -delete 2>/dev/null || true

count="${#claimed[@]}"
if [ "$count" -eq 0 ]; then
  silent "inbox empty" '{}'
fi

# ---- 步骤 4：按 messageId 组装 recent_context（一次 wake 可能带多条、来自不同聊天） ----
ids="$(printf '%s\n' "${claimed[@]}" | jq -R . | jq -s -c .)"
# 注意：$( ) 里 heredoc 开头那行不能接 "|| echo"，bash 会报语法错、wake 永远发不出去
ctx_json="$(python3 - "$CTX_DIR" "${claimed[@]}" 2>/dev/null <<'PYEOF'
import json, os, re, sys
ctx_dir = sys.argv[1]

def safe(chat):
    return re.sub(r"[^A-Za-z0-9_-]", "_", chat or "") or "unknown"

def load(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return {}

pending = load(os.path.join(ctx_dir, "feishu-ctx-pending.json"))
out = {}
for mid in sys.argv[2:]:
    me = pending.get(mid, {})
    chat = me.get("chatId", "unknown")
    ctx = load(os.path.join(ctx_dir, "feishu-ctx-%s.json" % safe(chat)))
    turns = list(ctx.get("turns", []))
    # 同一聊天里比这条更早、还没回复完的消息（用户连发几条时）：只有用户原文，assistant 标成处理中
    earlier = sorted((v.get("at", ""), k) for k, v in pending.items()
                     if k != mid and v.get("chatId") == chat and v.get("at", "") < me.get("at", ""))
    for _, k in earlier:
        turns.append({"user": pending[k].get("text", ""), "assistant": "（这条还在处理中，回复尚未发出）", "ts": pending[k].get("ts", 0)})
    out[mid] = turns
print(json.dumps(out, ensure_ascii=False))
PYEOF
)"
# python 出错时退回空上下文，保证 wake 照常发出
if ! printf '%s' "$ctx_json" | jq -e 'type == "object"' >/dev/null 2>&1; then ctx_json='{}'; fi

# 注意：轮询检查本身不写日志（5 秒一次，写日志会刷屏）；wake 由运行时记录。
wake "feishu inbox 有 $count 条待处理消息" "{\"count\":$count,\"message_ids\":$ids,\"recent_context\":$ctx_json}"
