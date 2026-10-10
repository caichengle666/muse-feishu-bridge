/**
 * lock.ts — daemon 单实例锁（0.2.1）。
 *
 * daemon 自己用 O_EXCL（open "wx"）创建 daemon.lock，内容为 `<pid> <starttime> <token>`，
 * 不再依赖 keepalive 的"先检查再拉起"（check-then-start 有竞态，手动 npm start 也绕得过）。
 *
 * 已存在的锁：
 *   - 持有者仍活着（pid 存在且 starttime 相同）→ 获取失败；
 *   - 持有者已死 / pid 被复用（starttime 不同）/ 内容损坏 → 视为陈旧锁，
 *     先把它 rename 到唯一的 daemon.lock.stale.<rand>（rename 是原子的，多个竞争者只有一个能拿走同一个 inode），
 *     再核对拿走的 inode 与判定为陈旧时 stat 到的 inode 相同；不同说明拿走的是别人刚创建的新锁，
 *     用 link()（不覆盖）放回原处，然后重试。
 * 进程退出时只在锁内容仍是自己的 token 时才删除。
 */
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { formatIdentity, isSameProcessAlive, parseIdentity, type Identity } from "./proc.js";

export type LockResult = { ok: true; reclaimed: boolean } | { ok: false; holder: Identity | null; reason: string };

export interface LockOptions {
  /** 判定持有者是否存活（测试可注入） */
  isAlive?: (id: Identity) => boolean;
  maxTries?: number;
}

export function acquireInstanceLock(path: string, self: Identity, opts: LockOptions = {}): LockResult {
  const isAlive = opts.isAlive ?? ((id: Identity) => isSameProcessAlive(id));
  const maxTries = opts.maxTries ?? 5;
  let reclaimed = false;
  for (let i = 0; i < maxTries; i++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, formatIdentity(self));
      } finally {
        closeSync(fd);
      }
      return { ok: true, reclaimed };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // 锁已存在：看持有者
    let raw: string, ino: number;
    try {
      ino = statSync(path).ino;
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // 刚被删/改名，重试
    }
    const holder = parseIdentity(raw);
    if (holder && holder.token === self.token && holder.pid === self.pid) return { ok: true, reclaimed };
    if (holder && isAlive(holder)) return { ok: false, holder, reason: `已有 daemon 持有锁（pid ${holder.pid}）` };
    // 陈旧锁：rename 拿走，再核对 inode
    const stale = `${path}.stale.${randomBytes(4).toString("hex")}`;
    try {
      renameSync(path, stale);
    } catch {
      continue; // 被别人先拿走了
    }
    let staleIno = -1;
    try {
      staleIno = statSync(stale).ino;
    } catch {
      /* ignore */
    }
    if (staleIno !== ino) {
      // 拿走的是别人刚建的新锁：不覆盖地放回去
      try {
        linkSync(stale, path);
      } catch {
        /* 原处又有了新锁：放弃放回（极端三方竞态，见 DESIGN.md） */
      }
      rmSync(stale, { force: true });
      continue;
    }
    rmSync(stale, { force: true });
    reclaimed = true;
  }
  return { ok: false, holder: null, reason: "多次尝试仍无法获取 daemon.lock" };
}

/** 只在锁仍属于 self（token 相同）时删除。 */
export function releaseInstanceLock(path: string, self: Identity): void {
  try {
    const cur = parseIdentity(readFileSync(path, "utf8"));
    if (cur && cur.token === self.token) rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}
