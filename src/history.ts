/**
 * history.ts — 按会话落盘的对话历史（0.3.9）。
 *
 * 背景：Muse 的 hook 每次 wake 都是全新 worker，看不到上一次的对话；平台也没有往 side chat
 * 追加 turn 的入口。所以上下文只能由桥自己记、自己送：
 *   - 每收到一条入队的用户消息、每成功发出一条回复，各追加一行到 history/<会话>.jsonl；
 *   - 写 inbox 时把本会话最近的若干轮放进 history 字段（按时间正序，不含本条），
 *     并给出 historyFile（完整记录的路径），worker 需要更早的内容可以自己读。
 *
 * 会话 = messages.ts 的 conversationKey()：私聊按人、群按群、话题按话题，互不串。
 * 落盘而不是放内存：运行环境一天会重启好几次。只存文字和附件路径，不存二进制。
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SerialQueue } from "./fsutil.js";

export interface HistoryEntry {
  role: "user" | "assistant";
  text: string;
  ts: string;
  messageId?: string;
  /** 群聊里的发送者称呼 / 协作机器人名字；私聊的用户消息不带 */
  senderName?: string;
  senderOpenId?: string;
  fromBot?: boolean;
}

export interface HistoryOptions {
  /** 每条 inbox 带最近多少轮（1 轮 ≈ 一问一答）；0 = 关闭历史功能。默认 20 */
  turns: number;
  /** 带进 inbox 的历史总字数上限（超出从最旧的开始丢），默认 12000 */
  maxChars: number;
  /** 单条写进 inbox 时的字数上限（超出截断并注明），默认 2000；文件里保留更长的原文 */
  maxEntryChars: number;
  /** 多少天没新消息的会话文件被清理，默认 7 */
  ttlMs: number;
  now: () => number;
}

/** 文件里单条最多保留的字数，防止一条超长回复把文件撑爆 */
const FILE_ENTRY_MAX = 20_000;
/** 文件超过这么大就压缩，只保留最近 KEEP_LINES 行 */
const COMPACT_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 400;

export function historyFileName(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180);
  return `${safe || "_"}.jsonl`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（已截断，原文 ${text.length} 字）`;
}

export class HistoryStore {
  private readonly q = new SerialQueue();
  readonly enabled: boolean;

  constructor(
    private readonly dir: string,
    private readonly opts: HistoryOptions,
  ) {
    this.enabled = opts.turns > 0;
  }

  fileFor(key: string): string {
    return join(this.dir, historyFileName(key));
  }

  /** 追加一条。失败只抛给调用方记日志，不影响收发。 */
  append(key: string, entry: HistoryEntry): Promise<void> {
    if (!this.enabled || !key) return Promise.resolve();
    const file = this.fileFor(key);
    const line = JSON.stringify({ ...entry, text: clip(entry.text, FILE_ENTRY_MAX) }) + "\n";
    return this.q.run(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await appendFile(file, line, { mode: 0o600 });
      try {
        const st = await stat(file);
        if (st.size > COMPACT_BYTES) await this.compact(file);
      } catch {
        /* ignore */
      }
    });
  }

  private async compact(file: string): Promise<void> {
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, lines.slice(-KEEP_LINES).join("\n") + "\n", { mode: 0o600 });
    await rename(tmp, file);
  }

  private async readAll(key: string): Promise<HistoryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(key), "utf8");
    } catch {
      return [];
    }
    const out: HistoryEntry[] = [];
    for (const l of raw.split("\n")) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l) as HistoryEntry;
        if (e && (e.role === "user" || e.role === "assistant") && typeof e.text === "string") out.push(e);
      } catch {
        /* 半行（崩溃时写到一半）跳过 */
      }
    }
    return out;
  }

  /**
   * 最近的历史（时间正序），给 inbox 用：最多 turns*2 条，总字数不超过 maxChars。
   * excludeMessageId：排除当前这条（防止重推时自己出现在自己的历史里）。
   */
  async recent(key: string, excludeMessageId?: string): Promise<HistoryEntry[]> {
    if (!this.enabled || !key) return [];
    const all = (await this.q.run(() => this.readAll(key))).filter((e) => !excludeMessageId || e.messageId !== excludeMessageId);
    const picked = all.slice(-this.opts.turns * 2).map((e) => ({ ...e, text: clip(e.text, this.opts.maxEntryChars) }));
    let total = picked.reduce((n, e) => n + e.text.length, 0);
    while (picked.length > 1 && total > this.opts.maxChars) total -= picked.shift()!.text.length;
    return picked;
  }

  /** 该会话是否已有记录（决定 inbox 里给不给 historyFile） */
  async has(key: string): Promise<boolean> {
    try {
      return (await stat(this.fileFor(key))).size > 0;
    } catch {
      return false;
    }
  }

  /** /new：清空当前会话的历史 */
  clear(key: string): Promise<boolean> {
    const file = this.fileFor(key);
    return this.q.run(async () => {
      try {
        await rm(file);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** 清理很久没动的会话文件（随巡检调用） */
  async prune(t = this.opts.now()): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const p = join(this.dir, n);
      try {
        const st = await stat(p);
        if (t - st.mtimeMs > this.opts.ttlMs) await rm(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
