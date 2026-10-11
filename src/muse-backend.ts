/**
 * muse-backend.ts — inbox 文件队列（daemon → Muse 助手）。
 *
 *   飞书消息 → enqueue() 原子写 inbox/<id>.json → hook 轮询认领并唤醒助手
 *   → 助手写 outbox/<id>.json → outbox.ts 投递。
 *
 * 原版 enqueue 的临时文件名是固定的 <id>.tmp（同一 id 并发写会互相覆盖），
 * 且 waitReply 与排空定时器各自读 outbox 导致重复发送；现在本模块只负责 inbox，
 * 回复投递统一由 outbox.ts 完成，超时由 bridge.ts 的巡检处理（重启后依然有效）。
 */
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "./fsutil.js";

export interface InboxAttachment {
  kind: "image" | "file" | "audio";
  /** 已下载到本机的绝对路径；下载失败时为空，并给出 error */
  path?: string;
  fileName?: string;
  error?: string;
}

export interface InboxItem {
  messageId: string;
  /** 回复目标（飞书 message_id）。普通消息 = messageId；卡片点击 = 被点击卡片的消息 id */
  replyTo: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
  msgType: string;
  text: string;
  ts: string;
  status: "new";
  /** 兼容旧字段：第一个已下载附件的路径 */
  filePath?: string;
  attachments?: InboxAttachment[];
  /** 卡片点击的原始 value / form_value */
  cardValue?: unknown;
  cardFormValue?: unknown;
  /** 消息里被 @ 的人/机器人，按出现顺序；本机器人自己那项带 isMe: true */
  mentions?: { openId: string; name: string; isMe?: boolean }[];
  /** 恒为 true：能进 inbox 就说明在叫本机器人（私聊，或群里 @ 了它） */
  addressedToMe?: boolean;
  /** 来自协作机器人（config.peerBots） */
  fromBot?: boolean;
  /** 协作机器人的称呼 */
  senderName?: string;
  /** 接力手数：用户发的 = 0，机器人转来的 ≥ 1 */
  hop?: number;
}

/** inbox id 只允许安全字符（飞书 om_… / 合成的 card_…），防路径穿越。 */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export class MuseBackend {
  constructor(private readonly dirs: { inbox: string; expired: string }) {}

  async init(): Promise<void> {
    for (const d of Object.values(this.dirs)) await mkdir(d, { recursive: true });
  }

  inboxPath(id: string): string {
    return join(this.dirs.inbox, `${id}.json`);
  }

  async enqueue(item: InboxItem): Promise<void> {
    if (!isSafeId(item.messageId)) throw new Error(`非法 messageId: ${item.messageId.slice(0, 40)}`);
    await atomicWriteJson(this.inboxPath(item.messageId), item);
  }

  /** inbox 里还没被 hook 认领（文件仍在）？ */
  isUnclaimed(id: string): boolean {
    return existsSync(this.inboxPath(id));
  }

  /**
   * 超时：把仍未被认领的 inbox 文件原子移到 expired/<id>.inbox.json。
   * 返回 true = 由我们拿走（助手不会再看到它）；false = 已被认领 / 不存在。
   * rename 是原子的，与 hook 的认领竞争时只有一方成功。
   */
  async expireUnclaimed(id: string): Promise<boolean> {
    try {
      await rename(this.inboxPath(id), join(this.dirs.expired, `${id}.inbox.json`));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * /stop：把这条的 inbox 文件（未认领的 <id>.json 或已认领的 <id>.json.claimed）原子移到
   * expired/<id>.inbox.json，并写 expired/<id>.stopped 标记（hook 据此把这一轮记成"被中断"）。
   * 返回原来的状态；两个文件都不在（已处理完 / 不存在）返回 null。
   */
  async stop(id: string, at: string): Promise<"unclaimed" | "claimed" | null> {
    if (!isSafeId(id)) return null;
    const dst = join(this.dirs.expired, `${id}.inbox.json`);
    let state: "unclaimed" | "claimed" | null = null;
    for (const [src, st] of [[this.inboxPath(id), "unclaimed"], [`${this.inboxPath(id)}.claimed`, "claimed"]] as const) {
      try {
        await rename(src, dst);
        state = st;
        break;
      } catch {
        /* 不在 / 刚被认领，试下一个 */
      }
    }
    if (state) await atomicWriteJson(join(this.dirs.expired, `${id}.stopped`), { at, state });
    return state;
  }

  /** 列出 inbox 里未认领的条目（巡检用）。损坏文件跳过。 */
  async listUnclaimed(): Promise<InboxItem[]> {
    let names: string[];
    try {
      names = (await readdir(this.dirs.inbox)).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    } catch {
      return [];
    }
    const out: InboxItem[] = [];
    for (const f of names) {
      try {
        const it = JSON.parse(await readFile(join(this.dirs.inbox, f), "utf8")) as InboxItem;
        if (it && typeof it.messageId === "string") out.push(it);
      } catch {
        /* 被并发认领 / 损坏 */
      }
    }
    return out;
  }
}
