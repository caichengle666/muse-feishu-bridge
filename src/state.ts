/**
 * state.ts — 持久化小状态：消息去重（seen.json）、心跳（heartbeat.json）、回复路由（routes.json）、
 * 卡片回调去重（card_events.json）、pid 文件（daemon.pid）。全部原子写。
 */
import { readFile, rm } from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import { atomicWriteJson, atomicWriteFile, SerialQueue } from "./fsutil.js";
import { formatIdentity, isSameProcessAlive, parseIdentity, type Identity } from "./proc.js";

export const MAX_SEEN = 2000;

/** 去重水位：保留最近 MAX_SEEN 个 msgid。save 串行化 + 合并（多次并发调用只写最后状态）。 */
export class SeenStore {
  private seen = new Set<string>();
  private readonly q = new SerialQueue();
  private dirty = false;

  constructor(private readonly path: string, private readonly max: number = MAX_SEEN) {}

  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const arr = (raw as { seen?: unknown })?.seen;
      this.seen = new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
    } catch {
      this.seen = new Set();
    }
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** 加入并持久化；返回 false 表示已见过（调用方应丢弃该消息）。 */
  async add(id: string): Promise<boolean> {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.max) {
      const arr = [...this.seen].slice(-this.max);
      this.seen = new Set(arr);
    }
    await this.save();
    return true;
  }

  /** 入队失败时撤销"已见过"，保证这条消息不会被当成重复而永远丢掉。 */
  async forget(id: string): Promise<void> {
    if (!this.seen.delete(id)) return;
    await this.save();
  }

  save(): Promise<void> {
    this.dirty = true;
    return this.q.run(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await atomicWriteJson(this.path, { seen: [...this.seen].slice(-this.max) });
    });
  }
}

export interface HeartbeatData {
  pid: number;
  ts: number;
  connected: boolean;
  /** 本次启动的随机令牌，与 daemon.pid 中的 token 相同才算"心跳来自这次启动" */
  token?: string;
}

/**
 * 心跳：只在长连接就绪（connected=true）时周期写入 {pid, ts, connected:true}；
 * 断开时立即写一次 {connected:false} 然后停止刷新——keepalive 据此判断"假活"。
 */
export class HeartbeatWriter {
  private connected = false;
  private readonly q = new SerialQueue();

  constructor(
    private readonly path: string,
    private readonly pid: number = process.pid,
    private readonly now: () => number = Date.now,
    private readonly token?: string,
  ) {}

  /** 启动时写一次 {connected:false, token}，让 keepalive 在连上之前也能核对 token。 */
  init(): Promise<void> {
    return this.write(false);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  setConnected(v: boolean): Promise<void> {
    const changed = v !== this.connected;
    this.connected = v;
    if (v || changed) return this.write(v);
    return Promise.resolve();
  }

  /** 周期调用：仅在已连接时写。 */
  tick(): Promise<void> {
    if (!this.connected) return Promise.resolve();
    return this.write(true);
  }

  private write(connected: boolean): Promise<void> {
    const data: HeartbeatData = { pid: this.pid, ts: this.now(), connected, ...(this.token ? { token: this.token } : {}) };
    return this.q.run(() => atomicWriteJson(this.path, data)).catch(() => undefined);
  }
}

/** pid 文件：一行 `<pid> <starttime> <token>`；只在 token 仍是本次启动时才删除。 */
export async function writePidFile(path: string, id: Identity): Promise<void> {
  await atomicWriteFile(path, formatIdentity(id));
}

export function readPidFile(path: string): Identity | null {
  try {
    return parseIdentity(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export async function removePidFile(path: string, id: Identity): Promise<void> {
  try {
    if (parseIdentity(await readFile(path, "utf8"))?.token === id.token) await rm(path, { force: true });
  } catch {
    /* 不存在 */
  }
}

export function removePidFileSync(path: string, id: Identity): void {
  try {
    if (parseIdentity(readFileSync(path, "utf8"))?.token === id.token) rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 读 pid 文件，若记录的进程仍活着（pid 存在且 starttime 相同——防 pid 复用）且命令行含 daemon.js，返回其 pid。
 * 只是诊断用；真正的单实例保证是 lock.ts 的 daemon.lock。
 */
export function livePeerDaemon(path: string, selfPid: number = process.pid): number | null {
  const id = readPidFile(path);
  if (!id || id.pid === selfPid) return null;
  if (!isSameProcessAlive(id)) return null;
  try {
    const cmd = readFileSync(`/proc/${id.pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return /daemon\.js/.test(cmd) ? id.pid : null;
  } catch {
    return null;
  }
}

/**
 * 卡片回调去重：键 = 回调 event_id / token（缺失时为 卡片消息 id + 操作人 + value 的哈希），
 * 带 TTL（默认 10 分钟）记在 card_events.json（原子写）。同一键在 TTL 内只入队一次。
 * check-and-add 在内存里同步完成（没有 await），同进程内的并发重复回调也只放过一个。
 */
export class CardEventDedupe {
  private seen = new Map<string, number>();
  private readonly q = new SerialQueue();

  constructor(
    private readonly path: string | null,
    private readonly ttlMs: number = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  loadSync(): void {
    if (!this.path) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { events?: Record<string, unknown> };
      const t = this.now();
      for (const [k, v] of Object.entries(raw.events || {})) {
        if (typeof v === "number" && t - v < this.ttlMs) this.seen.set(k, v);
      }
    } catch {
      /* 无文件或损坏：从空开始 */
    }
  }


  private prune(t: number): void {
    for (const [k, v] of this.seen) if (t - v >= this.ttlMs) this.seen.delete(k);
  }

  /** 首次（或 TTL 已过）返回 true 并记下；TTL 内重复返回 false。 */
  firstSeen(key: string): boolean {
    const t = this.now();
    this.prune(t);
    if (this.seen.has(key)) return false;
    this.seen.set(key, t);
    void this.persist();
    return true;
  }

  persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    return this.q.run(() => atomicWriteJson(path, { events: Object.fromEntries(this.seen) })).catch(() => undefined);
  }
}

/** 一条入站消息的回复路由：回复发到哪条飞书消息（reply 接口的 message_id）。 */
export interface Route {
  replyTo: string;
  chatId: string;
  senderOpenId: string;
  ts: number;
  /** 卡片模式：状态卡（"处理中"）的飞书 message_id，回复到达时原地更新它 */
  cardMessageId?: string;
  /** 状态卡已更新为最终结果（已完成 / 超时 / 失败） */
  cardFinal?: boolean;
}

/**
 * 回复路由表（routes.json）：inbox id → 回复目标。
 * 普通消息 replyTo = 自己的 message_id；卡片点击的 inbox id 是合成的（card_<hash>），
 * replyTo = 被点击的那张卡片的 open_message_id——原版直接拿合成 id 去调 reply 接口，必然失败。
 * 带 TTL（默认 3 天）与容量上限，原子写。
 */
export class RouteStore {
  private m = new Map<string, Route>();
  private readonly q = new SerialQueue();
  constructor(
    private readonly path: string | null,
    private readonly ttlMs = 3 * 24 * 3600_000,
    private readonly max = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  loadSync(): void {
    if (!this.path) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { routes?: Record<string, Route> };
      const t = this.now();
      for (const [k, v] of Object.entries(raw.routes || {})) {
        if (v && typeof v.replyTo === "string" && typeof v.ts === "number" && t - v.ts < this.ttlMs) this.m.set(k, v);
      }
    } catch {
      /* 从空开始 */
    }
  }

  get(id: string): Route | undefined {
    return this.m.get(id);
  }

  set(id: string, r: Route): Promise<void> {
    this.m.delete(id);
    this.m.set(id, r);
    const t = this.now();
    for (const [k, v] of this.m) if (t - v.ts >= this.ttlMs) this.m.delete(k);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
    return this.persist();
  }

  persist(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    return this.q.run(() => atomicWriteJson(path, { routes: Object.fromEntries(this.m) })).catch(() => undefined);
  }
}
