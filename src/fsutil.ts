/** fsutil.ts — 原子写（tmp + rename）与串行化工具。 */
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/** 原子写：先写同目录下的唯一 tmp 文件，再 rename 覆盖目标；读者永远看不到半截文件。 */
export async function atomicWriteFile(path: string, data: string | Buffer): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(value, null, 2));
}

/** 把异步任务排成一条队列依次执行（同一资源的写不会交错）。 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** 移动文件（同文件系统 rename）；目标目录不存在则创建。 */
export async function moveFile(src: string, dst: string): Promise<void> {
  await mkdir(dirname(dst), { recursive: true });
  await rename(src, dst);
}

/** 删除 dir 下 mtime 早于 maxAgeMs 的普通文件（不递归），返回删除数。 */
export async function pruneOldFiles(dir: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (name === ".gitkeep") continue;
    const p = join(dir, name);
    try {
      const st = await stat(p);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        await rm(p, { force: true });
        n++;
      }
    } catch {
      /* 并发删除等，忽略 */
    }
  }
  return n;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    try {
      return JSON.stringify(e).slice(0, 500);
    } catch {
      /* fallthrough */
    }
  }
  return String(e);
}
