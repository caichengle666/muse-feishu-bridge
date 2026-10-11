/**
 * bridge.ts — 飞书 × Muse 桥接的全部业务逻辑（与真实 SDK 解耦，可离线测试）。
 *
 * 入站：onMessage → 持久化去重（seen.json，按 message_id）→ 白名单 → 解析文本 / 下载附件
 *       → 记回复路由 → inbox/<id>.json → ack 计时器
 * 出站：唯一路径 OutboxDrainer（每秒一次）→ runDelivery（认领、分部件、uuid 幂等、进度落盘）
 * 巡检：每 30 秒（及启动时）处理超时：
 *   - inbox 文件仍未被认领（助手根本没接）→ 原子移到 expired/、写墓碑、告诉用户"请重发"；
 *     之后迟到的回复不会再发出（原版会先说"超时了请重发"、再把迟到的回复发出去，用户重发后又得到第二份）；
 *   - 已被认领但超时仍没回复 → 只提醒一次"还在处理"，不写墓碑，回复到了照常发。
 *   巡检基于 inbox 文件里的时间戳，daemon 重启后依然生效（原版的计时器只在内存里）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { FeishuCardAction, FeishuMessage } from "./types.js";
import { MuseBackend, isSafeId, type InboxAttachment, type InboxItem } from "./muse-backend.js";
import { OutboxDrainer, OutboxStore, partUuid, type Channel, type ReplyPayload } from "./outbox.js";
import { CardEventDedupe, HeartbeatWriter, RouteStore, SeenStore, type Route } from "./state.js";
import { makeIsAllowed, type BridgeConfig } from "./config.js";
import { parseMessageInput } from "./messages.js";
import { pruneOldFiles, errText, atomicWriteJson, SerialQueue } from "./fsutil.js";
import { parseSlashCommand, runSlashCommand } from "./slash.js";
import { buildReplyCard, fmtClock, fmtElapsed, CONTENT_ELEMENT_ID, type ReplyCardInput } from "./reply-card.js";
import { parseStreamText, streamDisplayText } from "./stream.js";
import { feishuCodeOf, httpStatusOf, isPermanentFeishuError } from "./feishu-retry.js";
import { extractMentions, findPeer, type PeerBot, mentionsOpenId, parseHop, resolveAts, type AtTarget } from "./mentions.js";
import { resolveAllowedRoots } from "./files.js";
import type { Paths } from "./paths.js";
import type { LogFn } from "./debug.js";

/** bridge 需要的 transport 能力（真实实现见 transport.ts，测试用假的）。 */
export interface BridgeTransport {
  replyText(messageId: string, text: string, opts?: { uuid?: string; atOpenId?: string; ats?: AtTarget[]; forceText?: boolean }): Promise<void>;
  replyCard(messageId: string, card: object, uuid?: string): Promise<unknown>;
  /** 原地更新一张已发出的卡片（PATCH /im/v1/messages/:id） */
  updateCard(messageId: string, card: object): Promise<void>;
  replyLocalFile(messageId: string, filePath: string, uuid?: string): Promise<unknown>;
  downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file", maxBytes?: number): Promise<{ bytes: Buffer; mimeType?: string }>;
  isRunning(): boolean;
  getBotOpenId(): string | undefined;
  /** CardKit 卡片实体（可选；没有或没权限时回退到普通卡片 + PATCH） */
  createCardEntity?(card: object): Promise<string>;
  replyCardEntity?(messageId: string, cardId: string, uuid?: string): Promise<string | undefined>;
  updateCardEntity?(cardId: string, card: object, sequence: number): Promise<void>;
  streamCardText?(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  setCardStreaming?(cardId: string, on: boolean, sequence: number): Promise<void>;
}

export interface BridgeDeps {
  transport: BridgeTransport;
  paths: Paths;
  config: BridgeConfig;
  backend: MuseBackend;
  outbox: OutboxStore;
  seen: SeenStore;
  routes: RouteStore;
  cardEvents: CardEventDedupe;
  heartbeat?: HeartbeatWriter;
  log: LogFn;
  now?: () => number;
  /** 以下为测试注入的时间参数 */
  ackDelayMs?: number;
  drainIntervalMs?: number;
  sweepIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** 流式输出轮询间隔（默认 1000ms） */
  streamIntervalMs?: number;
  pruneMaxAgeMs?: number;
  /** /status 显示的版本号 */
  version?: string;
}

const ACK_TEXT = "收到，正在处理，稍等…";
const TIMEOUT_UNCLAIMED_TEXT = "抱歉，这条消息等了很久都没被处理，已放弃。麻烦稍后再发一次。";
const TIMEOUT_SLOW_TEXT = "还在处理中，比平时慢一些，完成后会直接回复在这里。";
const SLASH_TITLES: Record<string, string> = { help: "📖 可用命令", ping: "🏓 Pong", status: "📊 桥接状态", ids: "🪪 open_id" };
const STOPPED_CARD_TEXT = "已被 /stop 中断，这条的回复不会再发出。";

/** 会话 id → stop/ 下的文件名（只留安全字符，被替换过就加短哈希防撞名） */
export function stopFileName(chatId: string): string {
  const c = chatId || "unknown";
  let k = c.replace(/[^A-Za-z0-9_-]/g, "_");
  if (k !== c) k += "_" + createHash("md5").update(c).digest("hex").slice(0, 8);
  return `${k}.json`;
}

/** CardKit 权限不足（没开 cardkit:card:write / 应用无权限）：HTTP 403 或 99991672 / 99991679 */
export function isCardkitPermissionError(e: unknown): boolean {
  const code = feishuCodeOf(e);
  return httpStatusOf(e) === 403 || code === 99991672 || code === 99991679;
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * 把飞书文本里的 @ 占位符（@_user_1）换成名字。
 * @机器人自己：默认去掉；markSelf=true 时保留成「@名字（你）」——给助手看，免得它以为自己没被点到。
 */
export function resolveMentions(text: string, mentions: unknown, botOpenId?: string, markSelf = false): string {
  if (!Array.isArray(mentions) || !text) return text;
  let out = text;
  for (const m of mentions as { key?: string; name?: string; id?: { open_id?: string } }[]) {
    if (!m || typeof m.key !== "string" || !m.key) continue;
    const isBot = Boolean(botOpenId) && m.id?.open_id === botOpenId;
    const repl = isBot ? (markSelf ? `@${m.name || "我"}（你）` : "") : `@${m.name || "某人"}`;
    // 键后面紧跟数字的不算（@_user_1 不能吃掉 @_user_10 的开头）
    const key = m.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(key + "(?!\\d)", "g"), () => repl);
  }
  return out.replace(/^\s+/, "").replace(/[ \t]{2,}/g, " ");
}

function safeFileName(name: string | undefined, fallback: string): string {
  const b = basename(String(name || "")).replace(/[\u0000-\u001f/\\]/g, "_").replace(/^\.+/, "_");
  return (b || fallback).slice(0, 120);
}

export interface Bridge {
  onMessage(msg: FeishuMessage): Promise<void>;
  onCardAction(action: FeishuCardAction): Promise<undefined>;
  drain(): ReturnType<OutboxDrainer["drain"]>;
  sweep(): Promise<void>;
  /** 把 stream/ 里的流式输出推到状态卡一次（定时器每秒调用；测试直接调） */
  pumpStreams(): Promise<void>;
  startTimers(): void;
  stopTimers(): void;
  /** 等待所有进行中的入站处理（测试用） */
  idle(): Promise<void>;
}

export function createBridge(d: BridgeDeps): Bridge {
  const now = d.now ?? Date.now;
  const startedAt = now();
  const recentText = new Map<string, number>();
  const log = d.log;
  const isAllowed = makeIsAllowed(d.config);
  const ownerOpenId = String(d.config.ownerOpenId || (d.config.allowedOpenIds || [])[0] || "");
  const replyTimeoutMs = (d.config.replyTimeoutMin ?? 20) * 60_000;
  const ackDelayMs = d.ackDelayMs ?? (d.config.ackDelaySec ?? 8) * 1000;
  const maxDownload = (d.config.maxDownloadMB ?? 20) * 1024 * 1024;
  const allowedRoots = resolveAllowedRoots(d.paths.root, d.config.allowedFileRoots);
  const engine = { root: d.paths.root, allowedRoots, log, now };
  const cardMode = (d.config.replyStyle ?? "card") === "card";
  /** "@主人" 兼容映射：正文出现就替换，不主动补 */
  const ownerAts: AtTarget[] = ownerOpenId ? [{ id: ownerOpenId, name: "主人" }] : [];
  // 拷贝一份：学到 / 填入的 open_id 写在这份上，不改调用方传进来的对象
  const peers: PeerBot[] = (Array.isArray(d.config.peerBots) ? d.config.peerBots : []).map((p) => ({ ...p }));
  const configQueue = new SerialQueue();
  const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]+$/;
  /** 协作机器人 @ 本机器人时，按 appId 认出来的：记下它在本应用里的 open_id（只在内存，不改配置文件） */
  const rememberPeerOpenId = (peer: PeerBot, openId: string) => {
    if (!OPEN_ID_RE.test(openId) || peer.openId === openId) return;
    log("daemon.peer_openid_seen", { peer: peer.name, openId, old: peer.openId });
    peer.openId = openId;
  };
  /** 用户在 /ids 卡片上点了"填入"：写进 config.json（已登记的补 openId，没登记的新增一条），并立即生效 */
  const savePeerOpenId = (name: string, openId: string): Promise<"updated" | "added" | "same"> =>
    configQueue.run(async () => {
      if (!existsSync(d.paths.config)) throw new Error("找不到 config.json");
      const raw = JSON.parse(await readFile(d.paths.config, "utf8")) as BridgeConfig;
      const list = Array.isArray(raw.peerBots) ? raw.peerBots : (raw.peerBots = []);
      // 先按 open_id 找（配置里的称呼可能和飞书显示名不同），再按名字找
      const entry = list.find((x) => x && x.openId === openId) || list.find((x) => x && x.name === name);
      let res: "updated" | "added" | "same";
      if (entry) {
        res = entry.openId === openId ? "same" : "updated";
        entry.openId = openId;
      } else {
        list.push({ name, openId });
        res = "added";
      }
      if (res !== "same") await atomicWriteJson(d.paths.config, raw);
      const live = peers.find((p) => p.openId === openId) || peers.find((p) => p.name === name);
      if (live) live.openId = openId;
      else peers.push({ name, openId });
      log("daemon.config_peer_saved", { peer: name, openId, res });
      return res;
    });
  /** /ids 卡片：列出 open_id，每个被 @ 的对象一个"填入配置"按钮 */
  const idsCard = (out: string, ms: { openId: string; name: string }[]) => {
    const c = card({ status: "info", title: SLASH_TITLES.ids, markdown: out }) as { body: { elements: Record<string, unknown>[] } };
    const buttons: Record<string, unknown>[] = [];
    for (const m of ms) {
      if (!OPEN_ID_RE.test(m.openId) || !m.name) continue;
      if (peers.some((p) => p.openId === m.openId)) continue; // 已经登记好了（不管配置里叫什么）
      const peer = peers.find((p) => p.name === m.name);
      buttons.push({
        tag: "button",
        text: { tag: "plain_text", content: peer ? `填入 ${m.name} 的 open_id` : `登记 ${m.name} 为协作机器人` },
        type: "primary",
        behaviors: [{ type: "callback", value: { mfb: "peer_fill", name: m.name, openId: m.openId } }],
      });
    }
    if (buttons.length) {
      c.body.elements.splice(1, 0, { tag: "markdown", content: "要写进 config.json 吗？点按钮确认（立即生效，不用重启）：" }, ...buttons);
    }
    return c;
  };
  const botMaxPerMinute = Math.max(1, Number(d.config.botMaxPerMinute) || 6);
  const botMaxHops = Math.max(1, Math.min(10, Number(d.config.botMaxHops) || 3));
  /** 每个会话最近接收的机器人消息时间戳（限频） */
  const botHits = new Map<string, number[]>();
  /** 正在发送中的"处理中"卡（回复到达时先等它发完，拿到 message_id 再原地更新） */
  const ackPending = new Map<string, Promise<void>>();

  const setRoute = async (id: string, patch: Partial<Pick<Route, "cardMessageId" | "cardFinal" | "cardId" | "cardSeq" | "cardStreaming">>) => {
    const r = d.routes.get(id);
    if (patch.cardFinal) usedSeq.delete(id); // 随时可删：重新从预留上限往后编，仍然严格递增
    if (r) await d.routes.set(id, { ...r, ...patch });
  };
  const elapsedFooter = (id: string): string[] => {
    const r = d.routes.get(id);
    return r ? [`耗时 ${fmtElapsed(now() - r.ts)}`, fmtClock(now())] : [fmtClock(now())];
  };
  const card = (input: ReplyCardInput) => buildReplyCard({ ats: ownerAts, ...input });

  // ---------------------------------------------------------------- CardKit 卡片实体 / 流式打字机
  const tk = d.transport;
  /** 没有 CardKit 能力或没权限（cardkit:card:write）时为 true：状态卡用普通卡片 + PATCH */
  let cardkitOff = !(tk.createCardEntity && tk.replyCardEntity && tk.updateCardEntity);
  const streamOff = d.config.streamReplies === false;
  const disableCardkit = (e: unknown) => {
    if (cardkitOff) return;
    cardkitOff = true;
    log("daemon.cardkit_disabled", { error: errText(e), hint: "开通 cardkit:card:write 权限并发布新版本后重启 daemon，即可启用打字机效果" });
  };
  /** 同一条消息的状态卡更新串行执行（流式推送、最终回复、/stop、超时不会互相覆盖或乱序） */
  const cardLocks = new Map<string, Promise<unknown>>();
  function withCardLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = cardLocks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    cardLocks.set(id, tail);
    void tail.then(() => {
      if (cardLocks.get(id) === tail) cardLocks.delete(id);
    });
    return run;
  }
  /**
   * CardKit sequence（每张卡严格递增，重启后也不能回退）。只在用完预留段时落盘：
   * routes.json 里记的是"预留到的上限"，重启后从上限往后编；流式时不必每次推送都重写 routes.json。
   */
  const SEQ_RESERVE = 50;
  const usedSeq = new Map<string, number>();
  const nextSeq = async (id: string): Promise<number> => {
    const reserved = d.routes.get(id)?.cardSeq ?? 0;
    const seq = (usedSeq.get(id) ?? reserved) + 1;
    usedSeq.set(id, seq);
    if (seq > reserved) await setRoute(id, { cardSeq: seq + SEQ_RESERVE - 1 });
    return seq;
  };
  /** 更新状态卡（须在 withCardLock 内调用）：卡片实体走 CardKit（先关流式），否则 PATCH。 */
  async function patchStatusCardLocked(id: string, c: object): Promise<void> {
    const r = d.routes.get(id);
    if (!r?.cardMessageId) return;
    if (r.cardId && tk.updateCardEntity) {
      if (r.cardStreaming && tk.setCardStreaming) {
        await tk.setCardStreaming(r.cardId, false, await nextSeq(id)).catch((e) => log("daemon.stream_close_failed", { msgid: id, error: errText(e) }));
        await setRoute(id, { cardStreaming: false });
      }
      await tk.updateCardEntity(r.cardId, c, await nextSeq(id));
      return;
    }
    await tk.updateCard(r.cardMessageId, c);
  }

  /**
   * 卡片模式下展示一张状态卡：有"处理中"卡就原地更新它，否则（或更新永久失败）新回复一张。
   * final=false 的卡（如"仍在处理"）新发出时会记成状态卡，之后的最终回复继续原地更新它。
   */
  async function showCard(id: string, replyTo: string, c: object, uuid: string, final: boolean): Promise<void> {
    await ackPending.get(id)?.catch(() => undefined);
    return withCardLock(id, () => showCardLocked(id, replyTo, c, uuid, final));
  }
  async function showCardLocked(id: string, replyTo: string, c: object, uuid: string, final: boolean): Promise<void> {
    const r = d.routes.get(id);
    if (r?.cardMessageId && !r.cardFinal) {
      try {
        await patchStatusCardLocked(id, c);
        if (final) await setRoute(id, { cardFinal: true });
        return;
      } catch (e) {
        if (!isPermanentFeishuError(e)) throw e; // 临时错误：交给上层重试（PATCH 本身幂等）
        log("daemon.card_patch_failed", { msgid: id, error: errText(e) });
        await setRoute(id, { cardFinal: true });
      }
    }
    const mid = await d.transport.replyCard(replyTo, c, uuid);
    if (!final && typeof mid === "string" && mid) await setRoute(id, { cardMessageId: mid, cardFinal: false });
  }

  /** 已认领但还没回复、尚未提醒过"还在处理"的消息：id → 入队时间 */
  const waiting = new Map<string, { at: number; replyTo: string }>();
  const ackTimers = new Map<string, NodeJS.Timeout>();
  const inflight = new Set<Promise<unknown>>();
  const timers: NodeJS.Timeout[] = [];

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => undefined);
    return p;
  };

  const resolveReplyTo = (p: ReplyPayload): string | null => {
    if (p.replyTo) return p.replyTo;
    const r = d.routes.get(p.messageId);
    if (r) return r.replyTo;
    return /^om_[A-Za-z0-9_-]+$/.test(p.messageId) ? p.messageId : null;
  };

  const makeChannel = (p: ReplyPayload): Channel | null => {
    const replyTo = resolveReplyTo(p);
    if (!replyTo) return null;
    const t = d.transport;
    // 解析 ats：只允许本条消息里被 @ 的、发送者、主人、协作机器人
    const r = d.routes.get(p.messageId);
    const res = resolveAts({ ats: p.ats, ownerOpenId: ownerOpenId || undefined, senderOpenId: r?.senderOpenId, senderName: r?.senderName, mentions: r?.mentions, peers, senderIsPeer: Boolean(r?.senderName), text: p.text });
    if (res.dropped.length) log("daemon.ats_dropped", { msgid: p.messageId, dropped: res.dropped });
    let targets = res.targets;
    // 接力链里（本条是机器人发来的）再 @ 别人：对方多半也是机器人，只是没在本机登记；按接力处理（纯文本 + 计手数），卡片里的 @ 不触发机器人
    const others = targets.filter((x) => x.id !== ownerOpenId && x.id !== r?.senderOpenId && !res.peerIds.has(x.id));
    const inChain = r?.hop !== undefined; // 本条是机器人接力来的
    let handoff = res.peerIds.size > 0 || (inChain && others.length > 0);
    let hopNote = "";
    if (handoff) {
      const outHop = (r?.hop ?? 0) + 1;
      if (outHop > botMaxHops) {
        // 接力到上限：不再 @ 机器人（接力链里的其他被 @ 对象也一并去掉），正常回复
        const drop = new Set([...res.peerIds, ...(inChain ? others.map((x) => x.id) : [])]);
        targets = targets.filter((x) => !drop.has(x.id));
        handoff = false;
        hopNote = `\n\n（机器人接力已达 ${botMaxHops} 手上限，这次没有再 @ 机器人）`;
        log("daemon.bot_hop_limit", { msgid: p.messageId, hop: outHop, max: botMaxHops });
      } else {
        hopNote = `\n〔接力 ${outHop}/${botMaxHops}〕`;
      }
    }
    // @ 了主人和发送者以外的人：对方可能是没登记的机器人（飞书事件分不出人和机器人），卡片里的 @ 叫不动机器人，所以发纯文本
    const plainText = handoff || targets.some((x) => x.id !== ownerOpenId && x.id !== r?.senderOpenId);
    const firstAts = [...targets, ...ownerAts];
    // 最终发送失败要不要由引擎告诉用户：经典模式要；卡片模式有状态卡时由 finalizeCards 改卡，没有卡才要
    const notifyOnFail = () => !cardMode || !d.routes.get(p.messageId)?.cardMessageId;
    if (plainText) {
      // @ 机器人（或可能是机器人的人）：整段作为一条纯文本发（对方只能收到 @ 它的那条消息；卡片里的 @ 不触发机器人）
      return {
        textChunkChars: 20_000,
        sendText: async (chunk, uuid, info) => {
          const idx = info?.index ?? 0;
          // 接力标记放在带 @ 的第一条：对方只收得到 @ 它的那条，标记放后面会读不到手数
          await t.replyText(replyTo, idx === 0 ? chunk + hopNote : chunk, { uuid, ats: idx === 0 ? firstAts : ownerAts, forceText: true });
        },
        sendFile: async (path, uuid) => void (await t.replyLocalFile(replyTo, path, uuid)),
        sendCard: async (c, uuid) => void (await t.replyCard(replyTo, c, uuid)),
        notify: (text) => t.replyText(replyTo, text).catch(() => undefined),
        get notifyOnFail() {
          return notifyOnFail();
        },
      };
    }
    return {
      sendText: async (chunk0, uuid, info) => {
        const lastPart = (info?.index ?? 0) === (info?.total ?? 1) - 1;
        const chunk = lastPart && hopNote ? chunk0 + hopNote : chunk0;
        const ats = (info?.index ?? 0) === 0 ? firstAts : ownerAts;
        if (!cardMode) return t.replyText(replyTo, chunk, { uuid, ats });
        const total = info?.total ?? 1;
        const idx = info?.index ?? 0;
        const c = card({
          status: "done",
          ats,
          markdown: chunk,
          part: { index: idx + 1, total },
          footer: idx === total - 1 ? elapsedFooter(p.messageId) : [],
        });
        if (idx === 0) return showCard(p.messageId, replyTo, c, uuid, true);
        await t.replyCard(replyTo, c, uuid);
      },
      sendFile: async (path, uuid) => void (await t.replyLocalFile(replyTo, path, uuid)),
      sendCard: async (card, uuid) => void (await t.replyCard(replyTo, card, uuid)),
      notify: (text) =>
        (cardMode ? t.replyCard(replyTo, card({ status: "failed", markdown: text })).then(() => undefined) : t.replyText(replyTo, text)).catch(() => undefined),
      get notifyOnFail() {
        return notifyOnFail();
      },
    };
  };

  const drainer = new OutboxDrainer({ store: d.outbox, makeChannel, engine });

  const delivered = (id: string) => {
    const loc = d.outbox.locate(id);
    return loc !== "none" || d.outbox.runs.has(id);
  };

  const clearAck = (id: string) => {
    const t = ackTimers.get(id);
    if (t) clearTimeout(t);
    ackTimers.delete(id);
  };

  /**
   * 发"处理中"状态卡（卡片模式）。有 CardKit 能力时发卡片实体（之后可流式打字机），否则普通卡片。
   * 同一条消息只发一次；回复/流式到达时先等它发完，拿到 message_id 再原地更新。
   */
  function startAckCard(id: string): Promise<void> {
    const existing = ackPending.get(id);
    if (existing) return existing;
    if (d.routes.get(id)?.cardMessageId) return Promise.resolve();
    const uuid = partUuid(id, "ack");
    // 卡片点击的 id 是合成的 card_<hash>，真正的回复目标在路由里
    const replyTo = d.routes.get(id)?.replyTo ?? id;
    const receivedAt = d.routes.get(id)?.ts ?? now();
    const c = card({ status: "running", markdown: ACK_TEXT, footer: [`收到于 ${fmtClock(receivedAt)}`] });
    const p = (async () => {
      if (!cardkitOff) {
        let cardId: string | null = null;
        try {
          cardId = await tk.createCardEntity!(c);
        } catch (e) {
          // 只有 CardKit 权限类错误才全局关掉打字机；其他错误只影响这一条（退回普通卡片）
          if (isCardkitPermissionError(e)) disableCardkit(e);
          else log("daemon.cardkit_create_failed", { msgid: id, error: errText(e) });
        }
        if (cardId) {
          try {
            const mid = await tk.replyCardEntity!(replyTo, cardId, uuid);
            usedSeq.delete(id);
            if (typeof mid === "string" && mid) await setRoute(id, { cardMessageId: mid, cardFinal: false, cardId, cardSeq: 0, cardStreaming: false });
            return;
          } catch (e) {
            if (!isPermanentFeishuError(e)) throw e;
            log("daemon.cardkit_reply_failed", { msgid: id, error: errText(e) }); // 这一条退回普通卡片
          }
        }
      }
      const mid = await d.transport.replyCard(replyTo, c, uuid);
      if (typeof mid === "string" && mid) await setRoute(id, { cardMessageId: mid, cardFinal: false });
    })()
      .catch((e) => log("daemon.ack_failed", { msgid: id, error: errText(e) }))
      .finally(() => ackPending.delete(id));
    ackPending.set(id, p);
    return p;
  }

  /** 流式：每条消息上次推到卡片的文本与时间 */
  const streamSeen = new Map<string, { text: string; at: number; truncated: boolean }>();
  const streamFile = (id: string) => join(d.paths.stream, `${id}.jsonl`);
  const dropStream = async (id: string) => {
    streamSeen.delete(id);
    await rm(streamFile(id), { force: true }).catch(() => undefined);
  };
  let pumping = false;
  /** 把 stream/<id>.jsonl 里 worker 已写出的内容推到状态卡（卡片模式）。 */
  async function pumpStreams(): Promise<void> {
    if (!cardMode || streamOff || pumping) return;
    pumping = true;
    try {
      let names: string[];
      try {
        names = await readdir(d.paths.stream);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -".jsonl".length);
        if (!isSafeId(id)) continue;
        const r = d.routes.get(id);
        const loc = d.outbox.locate(id);
        if (!r || r.cardFinal || loc === "sent" || loc === "failed" || loc === "expired" || d.outbox.hasTombstone(id)) {
          await dropStream(id);
          continue;
        }
        if (loc !== "none" || d.outbox.runs.has(id)) continue; // 最终回复正在投递
        const raw = await readFile(streamFile(id), "utf8").catch(() => null);
        if (raw == null) continue;
        const { text } = parseStreamText(raw);
        if (!text.trim()) continue;
        const prev = streamSeen.get(id);
        if (prev?.truncated) continue;
        const shown = streamDisplayText(text);
        if (prev && prev.text === shown.text) continue;
        if (prev && now() - prev.at < (r.cardId ? 900 : 1400)) continue;
        clearAck(id);
        waiting.delete(id); // 已经在输出了，不用再提醒"仍在处理"
        if (!d.routes.get(id)?.cardMessageId) await startAckCard(id);
        await ackPending.get(id)?.catch(() => undefined);
        // 推成功才记成"已显示"：失败的（含截断的最后一版）下一轮照样重推
        await withCardLock(id, () => pushStreamLocked(id, shown.text))
          .then(() => void streamSeen.set(id, { text: shown.text, at: now(), truncated: shown.truncated }))
          .catch((e) => {
            // 记下时间做节流，但不记文本：下一轮还会重推
            streamSeen.set(id, { text: "", at: now(), truncated: false });
            log("daemon.stream_failed", { msgid: id, error: errText(e) });
          });
      }
    } finally {
      pumping = false;
    }
  }
  async function pushStreamLocked(id: string, text: string): Promise<void> {
    const r = d.routes.get(id);
    if (!r?.cardMessageId || r.cardFinal) return;
    if (d.outbox.locate(id) !== "none" || d.outbox.runs.has(id)) return; // 最终回复到了，交给它
    const useKit = Boolean(r.cardId && tk.updateCardEntity && tk.streamCardText && tk.setCardStreaming);
    const c = card({ status: "running", title: "✍️ 正在输出", markdown: text, footer: elapsedFooter(id) });
    if (useKit) {
      const md = String(((c as { body?: { elements?: { content?: string }[] } }).body?.elements?.[0]?.content) ?? text);
      if (!r.cardStreaming) {
        // 先全量换成"正在输出"卡（带第一段），再用 settings 接口打开流式模式；之后的增量才有打字机动画
        await tk.updateCardEntity!(r.cardId!, c, await nextSeq(id));
        await tk.setCardStreaming!(r.cardId!, true, await nextSeq(id)).catch((e) => log("daemon.stream_open_failed", { msgid: id, error: errText(e) }));
        await setRoute(id, { cardStreaming: true });
        return;
      }
      try {
        await tk.streamCardText!(r.cardId!, CONTENT_ELEMENT_ID, md, await nextSeq(id));
      } catch (e) {
        if (!isPermanentFeishuError(e)) throw e;
        log("daemon.stream_text_failed", { msgid: id, error: errText(e) });
        await tk.updateCardEntity!(r.cardId!, c, await nextSeq(id));
      }
      return;
    }
    await tk.updateCard(r.cardMessageId, c);
  }

  async function downloadAttachments(msg: FeishuMessage, atts: { kind: "image" | "file" | "audio"; fileKey: string; fileName?: string }[]): Promise<InboxAttachment[]> {
    const out: InboxAttachment[] = [];
    if (!atts.length) return out;
    const dir = join(d.paths.incoming, msg.messageId);
    await mkdir(dir, { recursive: true });
    let i = 0;
    for (const a of atts.slice(0, 10)) {
      i++;
      try {
        const res = await d.transport.downloadMessageResource(msg.messageId, a.fileKey, a.kind === "image" ? "image" : "file", maxDownload);
        const ext = a.kind === "image" ? (res.mimeType === "image/png" ? ".png" : res.mimeType === "image/webp" ? ".webp" : res.mimeType === "image/gif" ? ".gif" : ".jpg") : "";
        const name = safeFileName(a.fileName, `${a.kind}-${i}${ext || (a.kind === "audio" ? ".opus" : ".bin")}`);
        const p = join(dir, `${i}-${name}`);
        await writeFile(p, res.bytes, { mode: 0o600 });
        out.push({ kind: a.kind, path: p, ...(a.fileName ? { fileName: a.fileName } : {}) });
      } catch (e) {
        out.push({ kind: a.kind, ...(a.fileName ? { fileName: a.fileName } : {}), error: errText(e).slice(0, 200) });
        log("daemon.download_failed", { msgid: msg.messageId, kind: a.kind, error: errText(e) });
      }
    }
    return out;
  }

  async function handleMessage(msg: FeishuMessage): Promise<void> {
    const id = msg.messageId;
    if (typeof id !== "string" || !isSafeId(id)) {
      log("daemon.bad_message_id", {});
      return;
    }
    // 持久化去重：飞书长连接未及时应答或重连时会按同一 message_id 重推；重启后也有效
    if (!(await d.seen.add(id))) {
      log("daemon.dedup", { msgid: id });
      return;
    }
    const botOpenId = d.transport.getBotOpenId();
    let peerName: string | undefined;
    if (msg.senderType === "bot") {
      // 机器人发来的：必须是登记过的协作机器人、必须 @ 了本机器人、且没超频
      const peer = findPeer(peers, msg.senderOpenId, msg.senderAppId);
      if (!peer) {
        log("daemon.blocked_bot_not_peer", { sender: msg.senderOpenId, appId: msg.senderAppId, chatId: msg.chatId });
        return;
      }
      if (!mentionsOpenId(msg.mentions, botOpenId)) {
        log("daemon.blocked_bot_not_mentioned", { msgid: id, peer: peer.name });
        return;
      }
      const t0 = now();
      const hits = (botHits.get(msg.chatId) || []).filter((x) => t0 - x < 60_000);
      if (hits.length >= botMaxPerMinute) {
        botHits.set(msg.chatId, hits);
        log("daemon.blocked_bot_rate", { msgid: id, peer: peer.name, perMinute: botMaxPerMinute });
        return;
      }
      hits.push(t0);
      botHits.set(msg.chatId, hits);
      peerName = peer.name;
      // 按 appId 认出来的：顺手记下它在本应用里的 open_id，以后回复就能 @ 它
      if (peer.appId && msg.senderAppId === peer.appId) rememberPeerOpenId(peer, msg.senderOpenId);
    } else if (!isAllowed(msg.senderOpenId)) {
      log("daemon.blocked_not_allowed", { sender: msg.senderOpenId, chatType: msg.chatType });
      return;
    }
    const fromBot = peerName !== undefined;
    const parsed = parseMessageInput(msg, botOpenId);
    let text = parsed.text;
    // 给助手看的正文：@自己 保留成「@名字（你）」；斜杠命令仍按去掉 @自己 的正文识别
    // 富文本（post）里 @自己 被标成「@名字（你）」，识别命令前去掉开头这一段
    let cmdText = parsed.text.replace(/^@[^\n@]*?（你）\s*/, "");
    if (msg.msgType === "text") {
      try {
        const j = JSON.parse(msg.content || "{}");
        if (typeof j.text === "string") {
          cmdText = resolveMentions(j.text, msg.mentions, botOpenId).trim();
          text = resolveMentions(j.text, msg.mentions, botOpenId, true).trim();
        }
      } catch {
        /* 保留 parsed.text */
      }
    }
    // 接力手数：用户发的 = 0；机器人发的读文末标记（没有就算第 1 手），并从正文去掉标记
    let hop = 0;
    if (fromBot) {
      const h = parseHop(text);
      text = h.text.trim();
      hop = h.hop ?? 1;
    }
    const mentions = extractMentions(msg.mentions, botOpenId);
    // 给助手的完整名单（按消息里的顺序，含自己并标 isMe）。回复路由仍用不含自己的 mentions
    const inboxMentions = extractMentions(msg.mentions).map((x) => (botOpenId && x.openId === botOpenId ? { ...x, isMe: true } : x));
    // 可选的同文本去重（默认关闭，见 config.dedupSameTextSeconds 的说明）
    const sameTextMs = Math.max(0, Number(d.config.dedupSameTextSeconds) || 0) * 1000;
    if (sameTextMs > 0 && msg.msgType === "text" && text) {
      const key = sha(`${msg.senderOpenId}|${msg.chatId}|${text}`);
      const t0 = now();
      for (const [k, v] of recentText) if (t0 - v >= sameTextMs) recentText.delete(k);
      const last = recentText.get(key);
      if (last !== undefined && t0 - last < sameTextMs) {
        log("daemon.dedup_same_text", { msgid: id, withinMs: t0 - last });
        return;
      }
      recentText.set(key, t0);
    }
    // 斜杠命令：白名单之后、下载附件和入队之前；只拦截已登记的命令，其余照常交给助手
    if ((msg.msgType === "text" || msg.msgType === "post") && !fromBot) {
      const slash = parseSlashCommand(cmdText);
      if (slash && slash.name === "stop") {
        await handleStop(msg, id);
        return;
      }
      if (slash) {
        let out: string | null = null;
        try {
          out = await runSlashCommand(slash, {
            chatType: msg.chatType,
            paths: d.paths,
            isRunning: () => d.transport.isRunning(),
            startedAt,
            now,
            version: d.version ?? "dev",
            senderOpenId: msg.senderOpenId,
            mentions,
          });
        } catch (e) {
          out = `命令 /${slash.name} 执行出错：${errText(e).slice(0, 200)}`;
        }
        if (out !== null) {
          log("daemon.slash", { msgid: id, cmd: slash.name });
          const uuid = partUuid(id, "slash");
          await (slash.name === "ids"
            ? d.transport.replyCard(id, idsCard(out, mentions || []), uuid) // 带按钮，经典模式也发卡片
            : cardMode
            ? d.transport.replyCard(id, card({ status: "info", title: SLASH_TITLES[slash.name] || `/${slash.name}`, markdown: out }), uuid)
            : d.transport.replyText(id, out, { uuid })
          ).catch((e) => log("daemon.slash_reply_failed", { msgid: id, error: errText(e) }));
          return;
        }
      }
    }
    const attachments = await downloadAttachments(msg, parsed.attachments);
    if (!text && !attachments.length) text = `[${msg.msgType} 消息，暂不支持解析]`;

    await d.routes.set(id, {
      replyTo: id,
      chatId: msg.chatId,
      senderOpenId: msg.senderOpenId,
      ts: now(),
      ...(mentions.length ? { mentions } : {}),
      ...(fromBot ? { senderName: peerName, hop } : {}),
    });
    const firstPath = attachments.find((a) => a.path)?.path;
    const item: InboxItem = {
      messageId: id,
      replyTo: id,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderOpenId: msg.senderOpenId,
      msgType: msg.msgType,
      text,
      ts: new Date(now()).toISOString(),
      status: "new",
      ...(firstPath ? { filePath: firstPath } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(inboxMentions.length ? { mentions: inboxMentions } : {}),
      // 私聊，或群里 @ 了本机器人 = 在叫你；groupPolicy=open 时没 @ 的群消息也会进来，那时为 false
      addressedToMe: msg.chatType === "p2p" || mentionsOpenId(msg.mentions, botOpenId),
      ...(fromBot ? { fromBot: true, senderName: peerName, hop } : {}),
    };
    try {
      await d.backend.enqueue(item);
    } catch (e) {
      // 原版这里没有兜底：inbox 写失败（磁盘满/权限）时消息已记为"见过"，飞书也已应答，静默丢失。
      // 现在撤销"见过"、记日志，并告诉用户这条没收到。
      await d.seen.forget(id).catch(() => undefined);
      log("daemon.enqueue_failed", { msgid: id, error: errText(e) });
      const msgText = "这条消息没能交给助手（本地写入失败），请稍后再发一次。";
      const uuid = partUuid(id, "enqueue_failed");
      await (cardMode ? d.transport.replyCard(id, card({ status: "failed", markdown: msgText }), uuid) : d.transport.replyText(id, msgText, { uuid }))
        .catch((e2) => log("daemon.enqueue_failed_notice", { msgid: id, error: errText(e2) }));
      return;
    }
    waiting.set(id, { at: now(), replyTo: id });
    log("daemon.enqueued", { msgid: id, type: msg.msgType, attachments: attachments.length });

    if (ackDelayMs > 0) {
      const t = setTimeout(() => {
        ackTimers.delete(id);
        if (delivered(id)) return;
        if (!cardMode) {
          void d.transport.replyText(id, ACK_TEXT, { uuid: partUuid(id, "ack") }).catch((e) => log("daemon.ack_failed", { msgid: id, error: errText(e) }));
          return;
        }
        void startAckCard(id);
      }, ackDelayMs);
      t.unref?.();
      ackTimers.set(id, t);
    }
  }

  /**
   * /stop：中断本会话里所有还没回完的消息（daemon 收到就处理，不进 inbox、不等 hook 轮询）。
   *   - inbox 里的（未认领 / 已认领）→ 移到 expired/，写 <id>.stopped 标记；
   *   - 写墓碑：worker 之后才写出的回复、正在分段发送的回复，都不会再发出去；
   *   - 写 stop/<会话>.json {chatId, at, messageId, cancelled}：worker 每步动手前查它，看到就自己停下；
   *   - "处理中"卡改成"已停止"，回用户一句。
   */
  async function handleStop(msg: FeishuMessage, id: string): Promise<void> {
    const at = new Date(now()).toISOString();
    const cancelled: string[] = [];
    for (const [mid, r] of d.routes.entries()) {
      if (mid === id || r.chatId !== msg.chatId || !isSafeId(mid)) continue;
      const loc = d.outbox.locate(mid);
      if (loc === "sent" || loc === "failed" || loc === "expired" || d.outbox.hasTombstone(mid)) continue;
      const st = await d.backend.stop(mid, at).catch(() => null);
      if (!st && loc !== "outbox" && loc !== "inflight") continue; // 早就回完了
      if (!st) await atomicWriteJson(join(d.paths.expired, `${mid}.stopped`), { at, state: loc }).catch(() => undefined);
      await d.outbox.tombstone(mid);
      waiting.delete(mid);
      clearAck(mid);
      cancelled.push(mid);
      await ackPending.get(mid)?.catch(() => undefined);
      const r2 = d.routes.get(mid);
      await dropStream(mid);
      if (cardMode && r2?.cardMessageId && !r2.cardFinal) {
        await withCardLock(mid, async () => {
          await patchStatusCardLocked(mid, card({ status: "stopped", markdown: STOPPED_CARD_TEXT, footer: elapsedFooter(mid) })).catch((e) =>
            log("daemon.stop_card_failed", { msgid: mid, error: errText(e) }),
          );
          await setRoute(mid, { cardFinal: true });
        });
      }
    }
    try {
      await mkdir(d.paths.stop, { recursive: true });
      await atomicWriteJson(join(d.paths.stop, stopFileName(msg.chatId)), { chatId: msg.chatId, at, messageId: id, cancelled });
    } catch (e) {
      log("daemon.stop_write_failed", { msgid: id, error: errText(e) });
    }
    log("daemon.stop", { msgid: id, chatId: msg.chatId, cancelled });
    const out = cancelled.length
      ? `已停止 ${cancelled.length} 个进行中的任务，它的回复不会再发出。\n已经执行完的步骤撤不回来；直接发新指令就行。`
      : "现在没有进行中的任务。直接发新指令就行。";
    const uuid = partUuid(id, "stop");
    await (cardMode
      ? d.transport.replyCard(id, card({ status: "stopped", title: "⏹️ 已停止", markdown: out }), uuid)
      : d.transport.replyText(id, out, { uuid })
    ).catch((e) => log("daemon.slash_reply_failed", { msgid: id, error: errText(e) }));
  }

  async function handleCardAction(action: FeishuCardAction): Promise<undefined> {
    const from = action.operatorOpenId || "";
    if (!isAllowed(from)) {
      log("daemon.card_blocked", { from });
      return undefined;
    }
    if (typeof action.messageId !== "string" || !/^om_[A-Za-z0-9_-]+$/.test(action.messageId)) {
      log("daemon.card_bad_message", {});
      return undefined;
    }
    const key =
      action.eventId ||
      action.token ||
      sha(JSON.stringify([action.messageId, from, action.value ?? null, action.formValue ?? null]));
    if (!d.cardEvents.firstSeen(key)) {
      log("daemon.card_dedup", { from });
      return undefined;
    }
    // /ids 卡片上的"填入配置"按钮：桥接自己处理，不交给助手
    const v = action.value as { mfb?: string; name?: unknown; openId?: unknown } | null;
    if (v && v.mfb === "peer_fill") {
      const name = String(v.name || "").trim();
      const openId = String(v.openId || "");
      let md: string;
      let status: "done" | "failed" = "done";
      if (!name || !OPEN_ID_RE.test(openId)) {
        md = "按钮数据不对，请重新发 /ids";
        status = "failed";
      } else {
        try {
          const res = await savePeerOpenId(name, openId);
          md =
            res === "added"
              ? `已把 **${name}** 登记为协作机器人，写入 config.json。\nopen_id：${openId}\n立即生效，不用重启。`
              : `已把 **${name}** 的 open_id 写入 config.json。\nopen_id：${openId}\n立即生效，不用重启。`;
        } catch (e) {
          md = `写入 config.json 失败：${errText(e).slice(0, 200)}`;
          status = "failed";
        }
      }
      await d.transport
        .updateCard(action.messageId, card({ status, title: status === "done" ? "✅ 已填入配置" : "❌ 没填进去", markdown: md }))
        .catch((e) => log("daemon.peer_fill_card_failed", { error: errText(e) }));
      return undefined;
    }
    const id = `card_${sha(key).slice(0, 24)}`;
    await d.routes.set(id, { replyTo: action.messageId, chatId: action.chatId || "", senderOpenId: from, ts: now() });
    await d.backend.enqueue({
      messageId: id,
      replyTo: action.messageId,
      chatId: action.chatId || "",
      chatType: "unknown",
      senderOpenId: from,
      msgType: "card_action",
      text: `[卡片点击] value=${JSON.stringify(action.value ?? null).slice(0, 1000)}`,
      cardValue: action.value ?? null,
      ...(action.formValue ? { cardFormValue: action.formValue } : {}),
      ts: new Date(now()).toISOString(),
      status: "new",
    });
    waiting.set(id, { at: now(), replyTo: action.messageId });
    log("daemon.card_enqueued", { id, from });
    return undefined;
  }

  async function sweep(): Promise<void> {
    const t = now();
    // 1) 未认领的超时消息（基于文件时间戳，重启后仍有效）
    for (const it of await d.backend.listUnclaimed()) {
      const ts = Date.parse(it.ts);
      if (!Number.isFinite(ts) || t - ts < replyTimeoutMs) continue;
      if (!isSafeId(it.messageId)) continue;
      if (!(await d.backend.expireUnclaimed(it.messageId))) continue; // 刚被认领
      await d.outbox.tombstone(it.messageId);
      waiting.delete(it.messageId);
      clearAck(it.messageId);
      const replyTo = it.replyTo || d.routes.get(it.messageId)?.replyTo || it.messageId;
      log("daemon.reply_timeout", { msgid: it.messageId, claimed: false });
      const uuid = partUuid(it.messageId, "timeout");
      await (cardMode
        ? showCard(it.messageId, replyTo, card({ status: "timeout", markdown: TIMEOUT_UNCLAIMED_TEXT, footer: elapsedFooter(it.messageId) }), uuid, true)
        : d.transport.replyText(replyTo, TIMEOUT_UNCLAIMED_TEXT, { uuid })
      ).catch((e) => log("daemon.timeout_notice_failed", { msgid: it.messageId, error: errText(e) }));
    }
    // 2) 已认领、超时仍无回复：提醒一次，不放弃
    for (const [id, w] of [...waiting]) {
      if (t - w.at < replyTimeoutMs) continue;
      waiting.delete(id);
      if (delivered(id) || d.backend.isUnclaimed(id) || d.outbox.hasTombstone(id)) continue;
      log("daemon.reply_slow", { msgid: id });
      const uuid = partUuid(id, "slow");
      await (cardMode
        ? showCard(id, w.replyTo, card({ status: "slow", markdown: TIMEOUT_SLOW_TEXT, footer: [`已等待 ${fmtElapsed(t - w.at)}`] }), uuid, false)
        : d.transport.replyText(w.replyTo, TIMEOUT_SLOW_TEXT, { uuid })
      ).catch(() => undefined);
    }
    for (const [id] of waiting) if (d.outbox.isSent(id)) waiting.delete(id);
    // 3) 清理旧文件（默认 7 天）
    const age = d.pruneMaxAgeMs ?? 7 * 24 * 3600_000;
    for (const dir of [d.paths.sent, d.paths.expired, d.paths.failed, d.paths.stop]) await pruneOldFiles(dir, age, t);
    await pruneIncoming(age, t);
  }

  async function pruneIncoming(age: number, t: number): Promise<void> {
    const { readdir, stat, rm } = await import("node:fs/promises");
    let names: string[] = [];
    try {
      names = await readdir(d.paths.incoming);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d.paths.incoming, n);
      try {
        const st = await stat(p);
        if (st.isDirectory() && t - st.mtimeMs > age) await rm(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 回复已发完 / 已失败，但"处理中"卡还没被更新（例如回复只有文件、没有文字）→ 补一次更新，
   * 免得卡片一直停在"处理中"。
   */
  async function finalizeCards(sent: string[], failed: string[]): Promise<void> {
    const jobs: [string, "done" | "failed"][] = [...sent.map((id) => [id, "done"] as [string, "done"]), ...failed.map((id) => [id, "failed"] as [string, "failed"])];
    for (const [id, st] of jobs) {
      await ackPending.get(id)?.catch(() => undefined);
      const r = d.routes.get(id);
      if (!r?.cardMessageId || r.cardFinal) continue;
      const c = card(
        st === "done"
          ? { status: "done", markdown: "结果已发送。", footer: elapsedFooter(id) }
          : { status: "failed", markdown: "回复没能完整发出，已记录到 failed/，可以让助手重发。", footer: elapsedFooter(id) },
      );
      await withCardLock(id, async () => {
        const r2 = d.routes.get(id);
        if (!r2?.cardMessageId || r2.cardFinal) return;
        try {
          await patchStatusCardLocked(id, c);
        } catch (e) {
          log("daemon.card_finalize_failed", { msgid: id, error: errText(e) });
        }
        await setRoute(id, { cardFinal: true });
      });
    }
  }

  async function drainOnce() {
    const r = await drainer.drain();
    for (const id of [...r.sent, ...r.failed, ...r.expired]) {
      clearAck(id);
      waiting.delete(id);
      await dropStream(id);
    }
    if (cardMode) await finalizeCards(r.sent, r.failed);
    return r;
  }

  let sweeping = false;
  const safeSweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await sweep();
    } catch (e) {
      log("daemon.sweep_error", { error: errText(e) });
    } finally {
      sweeping = false;
    }
  };

  return {
    onMessage: (msg) =>
      track(
        handleMessage(msg).catch((e) => {
          log("daemon.message_error", { msgid: msg?.messageId, error: errText(e) });
        }),
      ),
    onCardAction: (a) =>
      track(
        handleCardAction(a).catch((e) => {
          log("daemon.card_error", { error: errText(e) });
          return undefined;
        }),
      ),
    drain: () => drainOnce(),
    pumpStreams: () => pumpStreams(),
    sweep: safeSweep,
    startTimers() {
      const di = setInterval(() => {
        void drainOnce().catch((e) => log("daemon.drain_error", { error: errText(e) }));
      }, d.drainIntervalMs ?? 1000);
      const si = setInterval(() => void safeSweep(), d.sweepIntervalMs ?? 30_000);
      const hi = setInterval(() => {
        const hb = d.heartbeat;
        if (!hb) return;
        void hb.setConnected(d.transport.isRunning()).then(() => hb.tick());
      }, d.heartbeatIntervalMs ?? 20_000);
      const pi = setInterval(() => {
        void pumpStreams().catch((e) => log("daemon.stream_error", { error: errText(e) }));
      }, d.streamIntervalMs ?? 1000);
      timers.push(di, si, hi, pi);
      void safeSweep();
      if (d.heartbeat) void d.heartbeat.setConnected(d.transport.isRunning());
    },
    stopTimers() {
      for (const t of timers.splice(0)) clearInterval(t);
      for (const id of [...ackTimers.keys()]) clearAck(id);
    },
    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };
}
