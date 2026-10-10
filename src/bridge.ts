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
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { FeishuCardAction, FeishuMessage } from "./types.js";
import { MuseBackend, isSafeId, type InboxAttachment, type InboxItem } from "./muse-backend.js";
import { OutboxDrainer, OutboxStore, partUuid, type Channel, type ReplyPayload } from "./outbox.js";
import { CardEventDedupe, HeartbeatWriter, RouteStore, SeenStore } from "./state.js";
import { makeIsAllowed, type BridgeConfig } from "./config.js";
import { parseMessageInput } from "./messages.js";
import { pruneOldFiles, errText } from "./fsutil.js";
import { parseSlashCommand, runSlashCommand } from "./slash.js";
import { buildReplyCard, fmtClock, fmtElapsed, type ReplyCardInput } from "./reply-card.js";
import { isPermanentFeishuError } from "./feishu-retry.js";
import { resolveAllowedRoots } from "./files.js";
import type { Paths } from "./paths.js";
import type { LogFn } from "./debug.js";

/** bridge 需要的 transport 能力（真实实现见 transport.ts，测试用假的）。 */
export interface BridgeTransport {
  replyText(messageId: string, text: string, opts?: { uuid?: string; atOpenId?: string }): Promise<void>;
  replyCard(messageId: string, card: object, uuid?: string): Promise<unknown>;
  /** 原地更新一张已发出的卡片（PATCH /im/v1/messages/:id） */
  updateCard(messageId: string, card: object): Promise<void>;
  replyLocalFile(messageId: string, filePath: string, uuid?: string): Promise<unknown>;
  downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file", maxBytes?: number): Promise<{ bytes: Buffer; mimeType?: string }>;
  isRunning(): boolean;
  getBotOpenId(): string | undefined;
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
  pruneMaxAgeMs?: number;
  /** /status 显示的版本号 */
  version?: string;
}

const ACK_TEXT = "收到，正在处理，稍等…";
const TIMEOUT_UNCLAIMED_TEXT = "抱歉，这条消息等了很久都没被处理，已放弃。麻烦稍后再发一次。";
const TIMEOUT_SLOW_TEXT = "还在处理中，比平时慢一些，完成后会直接回复在这里。";
const SLASH_TITLES: Record<string, string> = { help: "📖 可用命令", ping: "🏓 Pong", status: "📊 桥接状态" };

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 把飞书文本里的 @ 占位符（@_user_1）换成名字；@机器人 去掉。 */
export function resolveMentions(text: string, mentions: unknown, botOpenId?: string): string {
  if (!Array.isArray(mentions) || !text) return text;
  let out = text;
  for (const m of mentions as { key?: string; name?: string; id?: { open_id?: string } }[]) {
    if (!m || typeof m.key !== "string" || !m.key) continue;
    const isBot = Boolean(botOpenId) && m.id?.open_id === botOpenId;
    out = out.split(m.key).join(isBot ? "" : `@${m.name || "某人"}`);
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
  const atId = ownerOpenId || undefined;
  /** 正在发送中的"处理中"卡（回复到达时先等它发完，拿到 message_id 再原地更新） */
  const ackPending = new Map<string, Promise<void>>();

  const setRoute = async (id: string, patch: { cardMessageId?: string; cardFinal?: boolean }) => {
    const r = d.routes.get(id);
    if (r) await d.routes.set(id, { ...r, ...patch });
  };
  const elapsedFooter = (id: string): string[] => {
    const r = d.routes.get(id);
    return r ? [`耗时 ${fmtElapsed(now() - r.ts)}`, fmtClock(now())] : [fmtClock(now())];
  };
  const card = (input: ReplyCardInput) => buildReplyCard({ atOpenId: atId, ...input });

  /**
   * 卡片模式下展示一张状态卡：有"处理中"卡就原地更新它，否则（或更新永久失败）新回复一张。
   * final=false 的卡（如"仍在处理"）新发出时会记成状态卡，之后的最终回复继续原地更新它。
   */
  async function showCard(id: string, replyTo: string, c: object, uuid: string, final: boolean): Promise<void> {
    await ackPending.get(id)?.catch(() => undefined);
    const r = d.routes.get(id);
    if (r?.cardMessageId && !r.cardFinal) {
      try {
        await d.transport.updateCard(r.cardMessageId, c);
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
    return {
      sendText: async (chunk, uuid, info) => {
        if (!cardMode) return t.replyText(replyTo, chunk, { uuid, atOpenId: atId });
        const total = info?.total ?? 1;
        const idx = info?.index ?? 0;
        const c = card({
          status: "done",
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
    if (!isAllowed(msg.senderOpenId)) {
      log("daemon.blocked_not_allowed", { sender: msg.senderOpenId, chatType: msg.chatType });
      return;
    }
    const parsed = parseMessageInput(msg, d.transport.getBotOpenId());
    let text = parsed.text;
    if (msg.msgType === "text") {
      try {
        const j = JSON.parse(msg.content || "{}");
        if (typeof j.text === "string") text = resolveMentions(j.text, msg.mentions, d.transport.getBotOpenId()).trim();
      } catch {
        /* 保留 parsed.text */
      }
    }
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
    if (msg.msgType === "text") {
      const slash = parseSlashCommand(text);
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
          });
        } catch (e) {
          out = `命令 /${slash.name} 执行出错：${errText(e).slice(0, 200)}`;
        }
        if (out !== null) {
          log("daemon.slash", { msgid: id, cmd: slash.name });
          const uuid = partUuid(id, "slash");
          await (cardMode
            ? d.transport.replyCard(id, card({ status: "info", title: SLASH_TITLES[slash.name] || `/${slash.name}`, markdown: out }), uuid)
            : d.transport.replyText(id, out, { uuid })
          ).catch((e) => log("daemon.slash_reply_failed", { msgid: id, error: errText(e) }));
          return;
        }
      }
    }
    const attachments = await downloadAttachments(msg, parsed.attachments);
    if (!text && !attachments.length) text = `[${msg.msgType} 消息，暂不支持解析]`;

    await d.routes.set(id, { replyTo: id, chatId: msg.chatId, senderOpenId: msg.senderOpenId, ts: now() });
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
        const uuid = partUuid(id, "ack");
        if (!cardMode) {
          void d.transport.replyText(id, ACK_TEXT, { uuid }).catch((e) => log("daemon.ack_failed", { msgid: id, error: errText(e) }));
          return;
        }
        const receivedAt = d.routes.get(id)?.ts ?? now();
        const p = (async () => {
          const mid = await d.transport.replyCard(id, card({ status: "running", markdown: ACK_TEXT, footer: [`收到于 ${fmtClock(receivedAt)}`] }), uuid);
          if (typeof mid === "string" && mid) await setRoute(id, { cardMessageId: mid, cardFinal: false });
        })()
          .catch((e) => log("daemon.ack_failed", { msgid: id, error: errText(e) }))
          .finally(() => ackPending.delete(id));
        ackPending.set(id, p);
      }, ackDelayMs);
      t.unref?.();
      ackTimers.set(id, t);
    }
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
    for (const dir of [d.paths.sent, d.paths.expired, d.paths.failed]) await pruneOldFiles(dir, age, t);
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
      try {
        await d.transport.updateCard(r.cardMessageId, c);
      } catch (e) {
        log("daemon.card_finalize_failed", { msgid: id, error: errText(e) });
      }
      await setRoute(id, { cardFinal: true });
    }
  }

  async function drainOnce() {
    const r = await drainer.drain();
    for (const id of [...r.sent, ...r.failed, ...r.expired]) {
      clearAck(id);
      waiting.delete(id);
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
      timers.push(di, si, hi);
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
