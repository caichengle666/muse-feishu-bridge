/** 测试辅助：假 transport + 临时 ROOT。不连接任何网络。 */
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths, type Paths } from "../paths.js";
import { MuseBackend } from "../muse-backend.js";
import { OutboxStore } from "../outbox.js";
import { CardEventDedupe, HeartbeatWriter, RouteStore, SeenStore } from "../state.js";
import { createBridge, type Bridge, type BridgeTransport } from "../bridge.js";
import type { BridgeConfig } from "../config.js";
import type { FeishuMessage } from "../types.js";

export interface Call {
  method: string;
  target: string;
  arg: unknown;
  uuid?: string;
}

/** 假 transport：记录调用；可注入失败 / 挂起；按 uuid 模拟飞书的幂等去重（1 小时内同 uuid 只算一条）。 */
export class FakeTransport implements BridgeTransport {
  calls: Call[] = [];
  delivered: Call[] = [];
  running = true;
  private failures: { method: string; err: unknown }[] = [];
  private gates = new Map<string, Promise<void>>();
  private uuids = new Set<string>();

  failNext(method: string, err: unknown, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ method, err });
  }

  private nth = new Map<string, Map<number, unknown>>();
  /** 让 method 的第 n 次调用（1 基）失败 */
  failAt(method: string, n: number, err: unknown): void {
    const m = this.nth.get(method) || new Map<number, unknown>();
    m.set(n, err);
    this.nth.set(method, m);
  }

  hold(method: string): () => void {
    let release!: () => void;
    this.gates.set(method, new Promise<void>((r) => (release = r)));
    return () => {
      this.gates.delete(method);
      release();
    };
  }

  private async rec(method: string, target: string, arg: unknown, uuid?: string): Promise<void> {
    const c: Call = { method, target, arg, ...(uuid ? { uuid } : {}) };
    this.calls.push(c);
    const g = this.gates.get(method);
    if (g) await g;
    const n = this.calls.filter((x) => x.method === method).length;
    const e = this.nth.get(method)?.get(n);
    if (e !== undefined) throw e;
    const i = this.failures.findIndex((f) => f.method === method);
    if (i >= 0) throw this.failures.splice(i, 1)[0].err;
    if (uuid && this.uuids.has(uuid)) return; // 飞书按 uuid 去重
    if (uuid) this.uuids.add(uuid);
    this.delivered.push(c);
  }

  /** 用户看到的文字：纯文本回复 + 卡片正文（新发的卡片和原地更新的卡片） */
  texts(): string[] {
    return this.delivered
      .filter((c) => c.method === "replyText" || c.method === "replyCard" || c.method === "updateCard")
      .map((c) => (c.method === "replyText" ? String(c.arg) : cardText(c.arg)));
  }

  cards(): Call[] {
    return this.delivered.filter((c) => c.method === "replyCard" || c.method === "updateCard");
  }

  async replyText(messageId: string, text: string, opts: { uuid?: string; atOpenId?: string } = {}) {
    await this.rec("replyText", messageId, text, opts.uuid);
  }
  private cardSeq = 0;
  private cardIds = new Map<string, string>();
  async replyCard(messageId: string, card: object, uuid?: string) {
    await this.rec("replyCard", messageId, card, uuid);
    // 与飞书一致：同一 uuid 重复调用返回同一条消息
    if (uuid && this.cardIds.has(uuid)) return this.cardIds.get(uuid)!;
    const id = `om_card_${++this.cardSeq}`;
    if (uuid) this.cardIds.set(uuid, id);
    return id;
  }
  async updateCard(messageId: string, card: object) {
    await this.rec("updateCard", messageId, card);
  }
  async replyLocalFile(messageId: string, filePath: string, uuid?: string) {
    await this.rec("replyLocalFile", messageId, filePath, uuid);
    return { kind: "file" };
  }
  async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file") {
    await this.rec("download", messageId, { fileKey, type });
    return { bytes: Buffer.from(type === "image" ? "\x89PNG\r\n\x1a\nxxxxxxxx" : "hello"), mimeType: type === "image" ? "image/png" : undefined };
  }
  isRunning() {
    return this.running;
  }
  getBotOpenId() {
    return "ou_bot";
  }
}

/** 取卡片正文（第一个 markdown 元素） */
export function cardText(card: unknown): string {
  const els = (card as { body?: { elements?: { tag?: string; content?: string }[] } })?.body?.elements || [];
  return els.find((e) => e.tag === "markdown")?.content ?? "";
}

export function cardTitle(card: unknown): string {
  return String((card as { header?: { title?: { content?: string } } })?.header?.title?.content ?? "");
}

export interface Env {
  root: string;
  paths: Paths;
  t: FakeTransport;
  backend: MuseBackend;
  outbox: OutboxStore;
  seen: SeenStore;
  routes: RouteStore;
  cardEvents: CardEventDedupe;
  heartbeat: HeartbeatWriter;
  logs: { event: string; data?: Record<string, unknown> }[];
  bridge: Bridge;
  clock: { now: number };
}

export async function makeEnv(opts: { config?: BridgeConfig; root?: string; ackDelayMs?: number; t?: FakeTransport } = {}): Promise<Env> {
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "mfb-test-")));
  const paths = makePaths(root);
  for (const d of [paths.incoming, paths.outgoing]) await mkdir(d, { recursive: true });
  await writeFile(paths.secrets, "FEISHU_APP_ID=cli_real\nFEISHU_APP_SECRET=s3cr3t\n");
  const logs: Env["logs"] = [];
  const log = (event: string, data?: Record<string, unknown>) => void logs.push({ event, data });
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const backend = new MuseBackend({ inbox: paths.inbox, expired: paths.expired });
  await backend.init();
  const outbox = new OutboxStore({ outbox: paths.outbox, sent: paths.sent, failed: paths.failed, expired: paths.expired, progress: paths.progress, inflight: paths.inflight });
  await outbox.init();
  const seen = new SeenStore(paths.seen);
  await seen.load();
  const routes = new RouteStore(paths.routes, undefined, undefined, now);
  routes.loadSync();
  const cardEvents = new CardEventDedupe(paths.cardEvents, undefined, now);
  cardEvents.loadSync();
  const heartbeat = new HeartbeatWriter(paths.heartbeat);
  const t = opts.t ?? new FakeTransport();
  const bridge = createBridge({
    transport: t,
    paths,
    // 投递引擎的老测试按 classic（纯文本）断言；卡片样式另有专门测试（传 replyStyle: "card"）
    config: { replyStyle: "classic", ...(opts.config ?? { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1 }) },
    backend,
    outbox,
    seen,
    routes,
    cardEvents,
    heartbeat,
    log,
    now,
    ackDelayMs: opts.ackDelayMs ?? 0,
  });
  return { root, paths, t, backend, outbox, seen, routes, cardEvents, heartbeat, logs, bridge, clock };
}

export function textMsg(id: string, text: string, extra: Partial<FeishuMessage> = {}): FeishuMessage {
  return { messageId: id, chatId: "oc_1", chatType: "p2p", senderOpenId: "ou_owner", msgType: "text", content: JSON.stringify({ text }), ...extra };
}

export async function writeOutbox(env: Env, id: string, payload: Record<string, unknown> | string): Promise<void> {
  const data = typeof payload === "string" ? payload : JSON.stringify({ messageId: id, ...payload });
  await writeFile(join(env.paths.outbox, `${id}.json`), data);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(5);
  }
  throw new Error("waitFor timeout");
}

export async function ls(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await readdir(dir)).sort() : [];
}

export async function readJson(p: string): Promise<any> {
  return JSON.parse(await readFile(p, "utf8"));
}

export function httpError(status: number, code?: number, msg = "err"): Error {
  const e = new Error(`Request failed with status code ${status}`) as Error & { response?: unknown };
  e.response = { status, data: code ? { code, msg } : {} };
  return e;
}
