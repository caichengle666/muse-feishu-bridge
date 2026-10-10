/**
 * outbox.ts — 回复投递引擎（移植自 muse-wecom-bridge 0.2.1，按飞书改写）。
 *
 * 原版有两条互不知情的发送路径：deliverReply（每 2 秒轮询 outbox/<id>.json）和
 * outbox 排空定时器（每 5 秒扫 outbox/）。两者会读到同一个文件、各发一遍 → 重复回复；
 * 发送失败被 .catch(() => undefined) 吞掉后照样归档到 sent/ → 回复静默丢失；
 * 排空路径失败时文件留在 outbox，每 5 秒从头重发一次已发成功的部分 → 无限刷屏。
 *
 * 现在只有一个入口 runDelivery()，一条回复拆成若干"部件"依次发送：
 *   text:0..n（textsplit.ts 切分，一段一条消息）→ file → card
 *   - 发送前认领：rename outbox/<id>.json → inflight/<id>.json（原子；谁 rename 成功谁发送）；
 *   - 同一 id 进程内互斥（Map<id, Promise>），跨进程由 daemon.lock 单实例保证；
 *   - 每发完一个部件把进度写进 progress/<id>.json，已发部件永不重发；
 *   - 每个部件带飞书 reply 的 uuid 幂等键 = sha256(id|部件)：即使"已发出但进度未落盘时崩溃"，
 *     恢复后重发也会被飞书按 uuid 去重（1 小时内），不会出现重复消息；
 *   - 永久错误（本地校验失败 / 飞书 4xx / 业务错误码）→ 该部件记失败、通知用户、其余部件照发，最后进 failed/；
 *   - 临时错误（限频、断网、5xx…）→ 按部件、按时间窗口计数（默认 1 小时 5 次），成功即清零；超限进 failed/；
 *   - 超时：写墓碑 expired/<id>.tombstone；之后迟到的回复直接移到 expired/，发送中的在部件之间看到墓碑即停止；
 *   - 崩溃恢复：拿到单实例锁后 recoverInflight()：inflight/* 移回 outbox/ 续发，有墓碑的进 expired/。
 */
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJson, atomicWriteFile, moveFile, errText } from "./fsutil.js";
import { splitReplyText, REPLY_CHUNK_CHARS } from "./textsplit.js";
import { checkOutgoingFile } from "./files.js";
import { describeFeishuError, isPermanentFeishuError } from "./feishu-retry.js";
import type { LogFn } from "./debug.js";

export interface ReplyPayload {
  /** outbox 文件名里的 id（= inbox 里的 messageId） */
  messageId: string;
  /** 回复发往哪条飞书消息；缺省由 routes.json 查，再缺省 = messageId */
  replyTo?: string;
  text: string;
  file?: string;
  card?: Record<string, unknown>;
  /** 要 @ 的对象：open_id 或名字（只能是本条消息里被 @ 的人、发送者、主人、peerBots） */
  ats?: string[];
}

/** 解析 outbox JSON。非法 JSON / 顶层不是对象 → 抛错（调用方决定重试还是失败）。 */
export function parseOutboxPayload(raw: string, fallbackId: string): ReplyPayload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("outbox 顶层必须是 JSON 对象");
  const o = parsed as Record<string, unknown>;
  const out: ReplyPayload = {
    messageId: typeof o.messageId === "string" && o.messageId ? o.messageId : fallbackId,
    text: typeof o.text === "string" ? o.text : o.text == null ? "" : String(o.text),
  };
  if (typeof o.file === "string" && o.file) out.file = o.file;
  if (o.card && typeof o.card === "object" && !Array.isArray(o.card)) out.card = o.card as Record<string, unknown>;
  if (typeof o.replyTo === "string" && /^om_[A-Za-z0-9_-]+$/.test(o.replyTo)) out.replyTo = o.replyTo;
  if (Array.isArray(o.ats)) out.ats = o.ats.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 20);
  return out;
}

// ---------------------------------------------------------------- errors

/** 本地校验失败等永久错误。 */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export function isPermanentError(e: unknown): boolean {
  return e instanceof PermanentError || isPermanentFeishuError(e);
}

/** 飞书 reply 幂等键：sha256(id|部件) 取 32 位十六进制（飞书限制 ≤50 字符，多条时还要加 -n 后缀）。 */
export function partUuid(id: string, partKey: string): string {
  return createHash("sha256").update(`${id}|${partKey}`).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------- store

export interface Progress {
  done: string[];
  failedParts: { part: string; reason: string }[];
  /** 当前失败部件在时间窗口内的临时失败次数（报告用） */
  attempts: number;
  /** 每个部件的临时失败时间戳（只保留窗口内），部件成功即删除 */
  partFailures: Record<string, number[]>;
  lastError?: string;
  updatedAt?: string;
}

export interface OutboxDirs {
  outbox: string;
  sent: string;
  failed: string;
  expired: string;
  progress: string;
  /** 认领中的回复；缺省为 <outbox>/../inflight */
  inflight?: string;
}

export type ClaimResult = "claimed" | "already_inflight" | "missing";
export type Location = "outbox" | "inflight" | "sent" | "failed" | "expired" | "none";

async function tryRename(src: string, dst: string): Promise<boolean> {
  try {
    await rename(src, dst);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      if (!existsSync(src)) return false; // 源已不在（被别人拿走）
      await mkdir(join(dst, ".."), { recursive: true });
      try {
        await rename(src, dst);
        return true;
      } catch {
        return false;
      }
    }
    throw e;
  }
}

export class OutboxStore {
  readonly dirs: Required<OutboxDirs>;
  /** 同一 id 的进程内互斥——进行中的投递 */
  readonly runs = new Map<string, Promise<DeliveryResult>>();

  constructor(dirs: OutboxDirs) {
    this.dirs = { ...dirs, inflight: dirs.inflight ?? join(dirs.outbox, "..", "inflight") };
  }

  async init(): Promise<void> {
    for (const d of Object.values(this.dirs)) await mkdir(d, { recursive: true });
  }

  outboxPath(id: string): string {
    return join(this.dirs.outbox, `${id}.json`);
  }

  inflightPath(id: string): string {
    return join(this.dirs.inflight, `${id}.json`);
  }

  async loadProgress(id: string): Promise<Progress> {
    try {
      const p = JSON.parse(await readFile(join(this.dirs.progress, `${id}.json`), "utf8")) as Partial<Progress>;
      const pf: Record<string, number[]> = {};
      if (p.partFailures && typeof p.partFailures === "object") {
        for (const [k, v] of Object.entries(p.partFailures)) {
          if (Array.isArray(v)) pf[k] = v.filter((x): x is number => typeof x === "number");
        }
      }
      return {
        done: Array.isArray(p.done) ? p.done : [],
        failedParts: Array.isArray(p.failedParts) ? p.failedParts : [],
        attempts: typeof p.attempts === "number" ? p.attempts : 0,
        partFailures: pf,
        ...(p.lastError ? { lastError: p.lastError } : {}),
      };
    } catch {
      return { done: [], failedParts: [], attempts: 0, partFailures: {} };
    }
  }

  async saveProgress(id: string, p: Progress): Promise<void> {
    await mkdir(this.dirs.progress, { recursive: true });
    await atomicWriteJson(join(this.dirs.progress, `${id}.json`), { ...p, updatedAt: new Date().toISOString() });
  }

  async clearProgress(id: string): Promise<void> {
    await rm(join(this.dirs.progress, `${id}.json`), { force: true }).catch(() => undefined);
  }

  /** 认领：outbox → inflight（原子 rename）。 */
  async claim(id: string): Promise<ClaimResult> {
    if (await tryRename(this.outboxPath(id), this.inflightPath(id))) return "claimed";
    // 同进程同 id 有互斥、跨进程有单实例锁，所以 inflight 里的文件只可能是本进程上次中断的（如抛异常），可直接续发
    return existsSync(this.inflightPath(id)) ? "already_inflight" : "missing";
  }

  /** 临时失败：inflight → outbox，等下次排空。 */
  async release(id: string): Promise<void> {
    await tryRename(this.inflightPath(id), this.outboxPath(id));
  }

  /** 从 inflight（优先）或 outbox 移到 dst */
  private async moveOut(id: string, dst: string): Promise<boolean> {
    if (await tryRename(this.inflightPath(id), dst)) return true;
    return tryRename(this.outboxPath(id), dst);
  }

  locate(id: string): Location {
    if (existsSync(this.outboxPath(id))) return "outbox";
    if (existsSync(this.inflightPath(id))) return "inflight";
    if (existsSync(join(this.dirs.sent, `${id}.json`))) return "sent";
    if (existsSync(join(this.dirs.failed, `${id}.json`))) return "failed";
    if (existsSync(join(this.dirs.expired, `${id}.json`))) return "expired";
    return "none";
  }

  /** 发送完成：inflight → sent/ */
  async archive(id: string): Promise<void> {
    await this.moveOut(id, join(this.dirs.sent, `${id}.json`)).catch(() => undefined);
    await this.clearProgress(id);
  }

  /** 永久失败：inflight（或 outbox）→ failed/<id>.json，并写 failed/<id>.reason.json */
  async fail(id: string, reason: string, progress?: Progress): Promise<void> {
    await this.moveOut(id, join(this.dirs.failed, `${id}.json`)).catch(() => undefined);
    await mkdir(this.dirs.failed, { recursive: true });
    await atomicWriteJson(join(this.dirs.failed, `${id}.reason.json`), {
      messageId: id,
      reason,
      ...(progress ? { done: progress.done, failedParts: progress.failedParts, attempts: progress.attempts } : {}),
      at: new Date().toISOString(),
    }).catch(() => undefined);
    await this.clearProgress(id);
  }

  tombstonePath(id: string): string {
    return join(this.dirs.expired, `${id}.tombstone`);
  }

  hasTombstone(id: string): boolean {
    return existsSync(this.tombstonePath(id));
  }

  /**
   * 超时：先写墓碑，再尝试 rename outbox → expired。返回谁拥有文件：
   *   "expired"  — 超时路径赢了（文件在 outbox，已移到 expired/，不会发送）；
   *   "inflight" — 已被发送方认领：墓碑已记下，发送方会在部件之间看到并停止剩余部件；
   *   "none"     — 文件还没出现（迟到的 outbox 文件之后会被直接移到 expired/）。
   */
  async tombstone(id: string): Promise<"expired" | "inflight" | "none"> {
    await mkdir(this.dirs.expired, { recursive: true });
    await atomicWriteFile(this.tombstonePath(id), new Date().toISOString() + "\n");
    if (await tryRename(this.outboxPath(id), join(this.dirs.expired, `${id}.json`))) {
      await this.clearProgress(id);
      return "expired";
    }
    return existsSync(this.inflightPath(id)) ? "inflight" : "none";
  }

  /** outbox/inflight → expired/<id>.json（不发送） */
  async expire(id: string): Promise<void> {
    await this.moveOut(id, join(this.dirs.expired, `${id}.json`)).catch(() => undefined);
    await this.clearProgress(id);
  }

  /** 发了一部分后发现墓碑：inflight → expired/，并写 expired/<id>.partial.json 说明已发/未发部件 */
  async expirePartial(id: string, prog: Progress, remaining: string[], note: string): Promise<void> {
    await this.moveOut(id, join(this.dirs.expired, `${id}.json`)).catch(() => undefined);
    await atomicWriteJson(join(this.dirs.expired, `${id}.partial.json`), {
      messageId: id,
      note,
      done: prog.done,
      failedParts: prog.failedParts,
      notSent: remaining,
      at: new Date().toISOString(),
    }).catch(() => undefined);
    await this.clearProgress(id);
  }

  isSent(id: string): boolean {
    return existsSync(join(this.dirs.sent, `${id}.json`));
  }

  /**
   * 崩溃恢复（必须在拿到单实例锁之后调用）：inflight/* → outbox/（续发时凭 progress 跳过已发部件）；
   * 有墓碑的 → expired/（附 partial 说明）。
   */
  async recoverInflight(): Promise<{ requeued: string[]; expired: string[] }> {
    const out = { requeued: [] as string[], expired: [] as string[] };
    let names: string[];
    try {
      names = (await readdir(this.dirs.inflight)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return out;
    }
    for (const f of names) {
      const id = f.slice(0, -".json".length);
      if (this.hasTombstone(id)) {
        const prog = await this.loadProgress(id);
        await this.expirePartial(id, prog, [], "崩溃恢复：已有超时墓碑，不再续发");
        out.expired.push(id);
      } else if (await tryRename(this.inflightPath(id), this.outboxPath(id))) {
        out.requeued.push(id);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- engine

/** 发送通道（飞书只有一种：reply 到某条消息）。uuid 为飞书幂等键。 */
export interface Channel {
  /** info：第几段 / 共几段（0 基 index），卡片模式用来决定"原地更新确认卡"还是新发一张 */
  sendText(chunk: string, uuid: string, info?: { index: number; total: number }): Promise<void>;
  sendFile(realPath: string, uuid: string): Promise<void>;
  sendCard(card: Record<string, unknown>, uuid: string): Promise<void>;
  /** 尽力通知用户（失败忽略） */
  notify(text: string): Promise<void>;
  /** 覆盖文本分段长度（@ 机器人接力时整段一条发，免得后面几段对方收不到） */
  textChunkChars?: number;
}

export interface EngineOptions {
  root: string;
  allowedRoots: string[];
  maxAttempts?: number;
  maxFileBytes?: number;
  chunkChars?: number;
  /** 临时错误计数窗口，默认 1 小时（窗口内同一部件失败 maxAttempts 次 → failed/） */
  attemptWindowMs?: number;
  /** 时钟（测试注入） */
  now?: () => number;
  log?: LogFn;
}

export type DeliveryResult =
  | { status: "sent" }
  | { status: "failed"; reason: string }
  | { status: "retry"; reason: string; attempts: number }
  /** 超时墓碑生效，未发（或只发了一部分，partial=true） */
  | { status: "expired"; partial?: boolean }
  /** outbox/inflight 都没有该文件（且不在 sent/failed/expired） */
  | { status: "missing" };

/**
 * 记一次临时失败（按部件、按时间窗口）。返回窗口内次数。
 */
export function recordTransientFailure(prog: Progress, key: string, now: number, windowMs: number): number {
  const arr = (prog.partFailures[key] || []).filter((t) => now - t < windowMs);
  arr.push(now);
  prog.partFailures[key] = arr;
  prog.attempts = arr.length;
  return arr.length;
}

interface Part {
  key: string;
  label: string;
  run: () => Promise<void>;
}

function buildParts(p: ReplyPayload, ch: Channel, opts: EngineOptions): Part[] {
  const id = p.messageId;
  const parts: Part[] = [];
  const chunks = splitReplyText(p.text, ch.textChunkChars ?? opts.chunkChars ?? REPLY_CHUNK_CHARS);
  chunks.forEach((c, i) => {
    const key = `text:${i}`;
    parts.push({ key, label: "文本", run: () => ch.sendText(c, partUuid(id, key), { index: i, total: chunks.length }) });
  });
  if (p.file) {
    const path = p.file;
    parts.push({
      key: "file",
      label: "文件",
      run: async () => {
        const chk = await checkOutgoingFile(path, {
          root: opts.root,
          allowedRoots: opts.allowedRoots,
          maxBytes: opts.maxFileBytes ?? 30 * 1024 * 1024,
        });
        if (!chk.ok) throw new PermanentError(chk.reason);
        await ch.sendFile(chk.realPath, partUuid(id, "file"));
      },
    });
  }
  if (p.card) {
    const card = p.card;
    parts.push({ key: "card", label: "卡片", run: () => ch.sendCard(card, partUuid(id, "card")) });
  }
  return parts;
}

/**
 * 按部件投递一条回复并落盘进度。返回 sent / failed / retry / expired / missing。
 *
 * 唯一入口，同一 id 进程内互斥——已有进行中的投递就直接返回它的 Promise（不会重复发送）。
 */
export function runDelivery(
  store: OutboxStore,
  payload: ReplyPayload,
  ch: Channel,
  opts: EngineOptions,
): Promise<DeliveryResult> {
  const id = payload.messageId;
  const inFlight = store.runs.get(id);
  if (inFlight) {
    (opts.log || (() => undefined))("daemon.delivery_joined", { msgid: id });
    return inFlight;
  }
  const p = runDeliveryLocked(store, payload, ch, opts).finally(() => {
    if (store.runs.get(id) === p) store.runs.delete(id);
  });
  store.runs.set(id, p);
  return p;
}

async function runDeliveryLocked(
  store: OutboxStore,
  payload: ReplyPayload,
  ch: Channel,
  opts: EngineOptions,
): Promise<DeliveryResult> {
  const id = payload.messageId;
  const log = opts.log || (() => undefined);
  const maxAttempts = opts.maxAttempts ?? 5;
  const windowMs = opts.attemptWindowMs ?? 3600_000;
  const now = opts.now ?? Date.now;

  if (store.hasTombstone(id)) {
    await store.expire(id);
    log("daemon.delivery_expired", { msgid: id, stage: "before_claim" });
    return { status: "expired" };
  }
  const claim = await store.claim(id);
  if (claim === "missing") {
    const loc = store.locate(id);
    if (loc === "sent") return { status: "sent" };
    if (loc === "expired") return { status: "expired" };
    if (loc === "failed") return { status: "failed", reason: "已在 failed/" };
    return { status: "missing" };
  }

  const prog = await store.loadProgress(id);
  try {
    const parts = buildParts(payload, ch, opts);
    const skip = new Set([...prog.done, ...prog.failedParts.map((f) => f.part)]);
    const todo = parts.filter((p) => !skip.has(p.key));

    for (let i = 0; i < todo.length; i++) {
      const part = todo[i];
      // 部件之间检查墓碑：超时路径没抢到文件（已在 inflight）时只能靠这里停下
      if (store.hasTombstone(id)) {
        const remaining = todo.slice(i).map((p) => p.key);
        await store.expirePartial(id, prog, remaining, "发送途中收到超时墓碑，停止剩余部件");
        log("daemon.delivery_expired", { msgid: id, stage: "between_parts", done: prog.done, remaining });
        return { status: "expired", partial: prog.done.length > 0 };
      }
      try {
        await part.run();
        prog.done.push(part.key);
        delete prog.partFailures[part.key]; // 成功即清零
        prog.attempts = 0;
        await store.saveProgress(id, prog);
      } catch (e) {
        const reason = describeFeishuError(e);
        if (isPermanentError(e)) {
          prog.failedParts.push({ part: part.key, reason });
          delete prog.partFailures[part.key];
          await store.saveProgress(id, prog);
          log("daemon.part_failed", { msgid: id, part: part.key, reason, permanent: true });
          if (part.key === "file" || part.key === "card") {
            await ch.notify(`${part.label}发送失败：${reason}`).catch(() => undefined);
          }
          continue;
        }
        const n = recordTransientFailure(prog, part.key, now(), windowMs);
        prog.lastError = `${part.key}: ${reason}`;
        log("daemon.part_failed", { msgid: id, part: part.key, reason, attempts: n });
        if (n >= maxAttempts) {
          const why = `临时错误在 ${Math.round(windowMs / 60000)} 分钟内重试 ${n} 次仍失败：${prog.lastError}`;
          await store.fail(id, why, prog);
          return { status: "failed", reason: why };
        }
        await store.saveProgress(id, prog);
        await store.release(id);
        return { status: "retry", reason, attempts: n };
      }
    }
  } catch (e) {
    // 意外异常（磁盘满等）：放回 outbox，别让文件卡在 inflight
    await store.release(id).catch(() => undefined);
    throw e;
  }

  if (prog.failedParts.length) {
    const why = prog.failedParts.map((f) => `${f.part}: ${f.reason}`).join("; ");
    await store.fail(id, why, prog);
    return { status: "failed", reason: why };
  }
  await store.archive(id);
  return { status: "sent" };
}

// ---------------------------------------------------------------- drain

export interface DrainDeps {
  store: OutboxStore;
  /** 给一条回复造发送通道；返回 null 表示找不到回复目标（进 failed/） */
  makeChannel: (p: ReplyPayload) => Channel | null;
  engine: EngineOptions;
}

export interface DrainReport {
  skipped: boolean;
  sent: string[];
  failed: string[];
  retry: string[];
  expired: string[];
}

function bucketOf(res: DeliveryResult): "sent" | "failed" | "retry" | "expired" | null {
  switch (res.status) {
    case "sent":
    case "failed":
    case "retry":
    case "expired":
      return res.status;
    default:
      return null;
  }
}

/**
 * 排空 outbox：把 outbox/ 里的回复逐条投递（唯一的发送路径）。
 * 进程内互斥：已有一次排空在跑时直接跳过（返回 skipped:true）。
 */
export class OutboxDrainer {
  private running = false;
  constructor(private readonly d: DrainDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  async drain(): Promise<DrainReport> {
    const rep: DrainReport = { skipped: false, sent: [], failed: [], retry: [], expired: [] };
    if (this.running) return { ...rep, skipped: true };
    this.running = true;
    try {
      await this.drainOnce(rep);
    } finally {
      this.running = false;
    }
    return rep;
  }

  private async drainOnce(rep: DrainReport): Promise<void> {
    const { store, engine } = this.d;
    const log = engine.log || (() => undefined);
    let files: string[];
    try {
      files = (await readdir(store.dirs.outbox)).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return;
    }
    if (!files.length) return;
    log("daemon.drain_start", { count: files.length });
    for (const f of files) {
      const id = f.slice(0, -".json".length);
      const path = store.outboxPath(id);
      if (store.runs.has(id)) continue; // 正在投递
      try {
        if (store.hasTombstone(id)) {
          await store.expire(id);
          rep.expired.push(id);
          log("daemon.drain_expired", { msgid: id });
          continue;
        }
        if (store.isSent(id)) {
          await rm(path, { force: true }).catch(() => undefined);
          await store.clearProgress(id);
          continue;
        }
        let raw: string;
        try {
          raw = await readFile(path, "utf8");
        } catch {
          continue; // 刚被别人移走
        }
        let payload: ReplyPayload;
        try {
          payload = parseOutboxPayload(raw, id);
        } catch (e) {
          // 可能是非原子写入的半截文件：按临时错误计次，超限进 failed/
          const prog = await store.loadProgress(id);
          recordTransientFailure(prog, "parse", (engine.now ?? Date.now)(), engine.attemptWindowMs ?? 3600_000);
          prog.lastError = `JSON 解析失败: ${errText(e)}`;
          if (prog.attempts >= (engine.maxAttempts ?? 5)) {
            await store.fail(id, prog.lastError, prog);
            rep.failed.push(id);
          } else {
            await store.saveProgress(id, prog);
            rep.retry.push(id);
          }
          log("daemon.drain_parse_error", { msgid: id, attempts: prog.attempts });
          continue;
        }
        payload.messageId = id; // 以文件名为准，进度/归档都按它
        const ch = this.d.makeChannel(payload);
        if (!ch) {
          await store.fail(id, "找不到回复目标：id 不是飞书 message_id（om_…），routes.json 里也没有，且未给 replyTo");
          rep.failed.push(id);
          log("daemon.drain_no_route", { msgid: id });
          continue;
        }
        const res = await runDelivery(store, payload, ch, engine);
        const b = bucketOf(res);
        if (b) rep[b].push(id);
        log("daemon.drain_result", { msgid: id, ...res });
      } catch (e) {
        log("daemon.drain_error", { msgid: id, error: errText(e) });
      }
    }
  }
}
