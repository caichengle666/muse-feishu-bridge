/**
 * mentions.ts — @ 他人 / 机器人之间接力。
 *
 * 入站：飞书 mentions（含 open_id）存进 inbox 和 routes.json，助手能拿到真实 open_id。
 * 出站：outbox 的 ats（open_id 或名字）→ 只允许 @ 白名单里的目标：
 *   本条消息里被 @ 的人/机器人、发送者、主人、config.peerBots 里登记的协作机器人。
 *   其他 open_id 和 @所有人 一律丢弃并记日志。
 * 接力：机器人之间互相 @ 时在文本末尾带 〔接力 n/max〕，每转一手 +1，超过上限就不再 @ 机器人，防止无限循环。
 */

export interface AtTarget {
  id: string;
  name: string;
  /** 正文里没有 "@名字" 时是否在开头补一个 @（显式 ats 才补；"@主人" 兼容映射只替换不补） */
  prefix?: boolean;
}

export interface MentionRef {
  openId: string;
  name: string;
}

export interface PeerBot {
  name: string;
  /** 本应用视角下该机器人的 open_id（用 /ids 获取）。发 @ 需要它 */
  openId?: string;
  /** 该机器人的 App ID（cli_ 开头），用于识别它发来的消息 */
  appId?: string;
}

const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
export const HOP_RE = /\s*〔接力 (\d+)\/(\d+)〕\s*$/;

/** 从飞书事件的 mentions 提取 {openId, name}，可排除某个 open_id（机器人自己）。 */
export function extractMentions(raw: unknown, excludeOpenId?: string): MentionRef[] {
  if (!Array.isArray(raw)) return [];
  const out: MentionRef[] = [];
  const seen = new Set<string>();
  for (const m of raw as { name?: unknown; id?: { open_id?: unknown } }[]) {
    const id = m?.id?.open_id;
    if (typeof id !== "string" || !OPEN_ID.test(id) || id === excludeOpenId || seen.has(id)) continue;
    seen.add(id);
    out.push({ openId: id, name: typeof m.name === "string" ? m.name.slice(0, 64) : "" });
  }
  return out;
}

/** 消息是否 @ 了 openId */
export function mentionsOpenId(raw: unknown, openId: string | undefined): boolean {
  if (!openId || !Array.isArray(raw)) return false;
  return (raw as { id?: { open_id?: unknown } }[]).some((m) => m?.id?.open_id === openId);
}

/** 读出并去掉文本末尾的接力标记。没有标记返回 hop=undefined。 */
export function parseHop(text: string): { text: string; hop?: number } {
  const m = HOP_RE.exec(text || "");
  if (!m) return { text };
  return { text: text.slice(0, m.index), hop: Math.max(1, Number(m[1]) || 1) };
}

export function findPeer(peers: PeerBot[] | undefined, openId?: string, appId?: string): PeerBot | undefined {
  return (peers || []).find((p) => (openId && p.openId === openId) || (appId && p.appId === appId));
}

/** 匹配正文里的 "@名字"。名字以英文/数字结尾时要求后面不是英文/数字，避免 "@B" 吃掉 "@Bob" */
function tokenRe(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("@" + esc + (/[A-Za-z0-9_]$/.test(name) ? "(?![A-Za-z0-9_])" : ""), "g");
}

/** 正文里是否出现 "@名字" */
export function textMentionsName(text: string, name: string): boolean {
  return Boolean(name) && tokenRe(name).test(text);
}

function escName(s: string): string {
  return s.replace(/[<>&"]/g, "");
}

/**
 * 把 targets 渲染进文本：正文里的 "@名字" 换成对应格式的 @ 标签；
 * prefix=true 且正文没提到的，在开头补 @。同一 open_id 只 @ 一次。
 * mode：card = 卡片 markdown <at id=..></at>；text = 文本消息 <at user_id="..">名字</at>。
 */
export function applyAts(text: string, targets: AtTarget[], mode: "card" | "text"): string {
  const seen = new Set<string>();
  const uniq = targets.filter((t) => t && OPEN_ID.test(t.id) && !seen.has(t.id) && (seen.add(t.id), true));
  // 长名字先替换，避免 "@张三" 吃掉 "@张三丰"
  const ordered = [...uniq].sort((a, b) => (b.name || "").length - (a.name || "").length);
  let out = text;
  const pre: string[] = [];
  const hits = new Map<string, boolean>();
  for (const t of ordered) {
    const tag = mode === "card" ? `<at id=${t.id}></at>` : `<at user_id="${t.id}">${escName(t.name || "某人")}</at>`;
    let hit = false;
    if (t.name) {
      const re = tokenRe(t.name);
      if (re.test(out)) {
        out = out.replace(tokenRe(t.name), () => tag);
        hit = true;
      }
    }
    hits.set(t.id, hit);
  }
  for (const t of uniq) if (t.prefix && !hits.get(t.id)) pre.push(mode === "card" ? `<at id=${t.id}></at>` : `<at user_id="${t.id}">${escName(t.name || "某人")}</at>`);
  return pre.length ? `${pre.join(" ")} ${out}` : out;
}

export interface ResolveAtsInput {
  ats: unknown;
  ownerOpenId?: string;
  senderOpenId?: string;
  senderName?: string;
  mentions?: MentionRef[];
  peers?: PeerBot[];
  /** 发送者是协作机器人（没填 openId 的也能 @ 回去，并按接力处理） */
  senderIsPeer?: boolean;
  /** 回复正文：里面写了 "@名字"（协作机器人或本条消息被 @ 的人）但没放进 ats 的，自动补上 */
  text?: string;
}

export interface ResolvedAts {
  targets: AtTarget[];
  /** 其中属于协作机器人的 open_id */
  peerIds: Set<string>;
  dropped: string[];
}

/** outbox.ats → 允许的 @ 目标（open_id 或名字均可）。不在允许范围内的丢弃。 */
export function resolveAts(input: ResolveAtsInput): ResolvedAts {
  const allowed = new Map<string, string>(); // open_id → 名字
  const byName = new Map<string, string>(); // 名字 → open_id
  const add = (id: string | undefined, name: string) => {
    if (!id || !OPEN_ID.test(id)) return;
    if (!allowed.has(id) || (!allowed.get(id) && name)) allowed.set(id, name);
    if (name && !byName.has(name)) byName.set(name, id);
  };
  const peerIds = new Set<string>();
  for (const p of input.peers || []) {
    add(p.openId, p.name);
    if (p.openId) peerIds.add(p.openId);
  }
  for (const m of input.mentions || []) add(m.openId, m.name);
  add(input.senderOpenId, input.senderName || "");
  if (input.senderIsPeer && input.senderOpenId && OPEN_ID.test(input.senderOpenId)) peerIds.add(input.senderOpenId);
  add(input.ownerOpenId, "主人");

  const targets: AtTarget[] = [];
  const dropped: string[] = [];
  const list: unknown[] = Array.isArray(input.ats) ? [...input.ats] : [];
  // 正文里写了 "@名字" 却没填 ats：按名字自动识别（主人仍走 "@主人" 兼容映射，不在这里补）
  if (input.text) {
    for (const [name, id] of byName) {
      if (name !== "主人" && textMentionsName(input.text, name) && !list.includes(name) && !list.includes(id)) list.push(name);
    }
  }
  for (const raw of list.slice(0, 20)) {
    if (typeof raw !== "string") continue;
    const v = raw.trim().replace(/^@/, "");
    const id = allowed.has(v) ? v : byName.get(v);
    if (!id) {
      dropped.push(v.slice(0, 64));
      continue;
    }
    if (!targets.some((t) => t.id === id)) targets.push({ id, name: allowed.get(id) || "", prefix: true });
  }
  return { targets, peerIds: new Set([...peerIds].filter((id) => targets.some((t) => t.id === id))), dropped };
}
