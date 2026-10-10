/**
 * proc.ts — 进程身份（0.2.1）：pid + 进程启动时间（/proc/<pid>/stat 第 22 字段）+ 随机启动令牌。
 *
 * 只看 pid 不可靠：daemon 死后 pid 可能被别的进程复用，keepalive 会误判"活着"甚至误杀无关进程。
 * 因此 daemon.pid / daemon.lock / heartbeat.json 都带上：
 *   - starttime：/proc/<pid>/stat 第 22 字段（自开机起的时钟滴答数），同一 pid 被复用时必然不同；
 *   - token：daemon 每次启动随机生成，heartbeat.json 也写同一个 token，用于确认"心跳确实来自这次启动"。
 *
 * /proc/<pid>/stat 解析：格式为 `pid (comm) state ppid ...`，comm 是可执行文件名（≤15 字节），
 * 可以包含空格和括号（例如 "a b) c"），所以必须截到【最后一个】')' 之后再按空白切分。
 * 截掉 "pid (comm) " 之后，剩余部分的第 1 个字段是总字段 3（state），
 * 于是总字段 N = 剩余部分第 (N-2) 个字段 = 0 基下标 N-3；
 * 第 22 字段（starttime）= 剩余第 20 个 = 0 基下标 19。keepalive.sh 用同样的下标。
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** 总字段 22（starttime）在"最后一个 ')' 之后的剩余部分"里的 0 基下标。 */
export const STARTTIME_REST_INDEX = 22 - 3;

export interface ProcStat {
  pid: number;
  comm: string;
  state: string;
  starttime: string;
}

/** 解析 /proc/<pid>/stat 的内容；格式不对返回 null。starttime 以十进制字符串返回（可能超出 2^53）。 */
export function parseProcStat(content: string): ProcStat | null {
  const open = content.indexOf("(");
  const close = content.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(content.slice(0, open).trim());
  const comm = content.slice(open + 1, close);
  const rest = content.slice(close + 1).trim().split(/\s+/);
  const starttime = rest[STARTTIME_REST_INDEX];
  if (!Number.isInteger(pid) || !starttime || !/^\d+$/.test(starttime)) return null;
  return { pid, comm, state: rest[0] || "", starttime };
}

/** 读取 pid 的启动时间（/proc/<pid>/stat 第 22 字段）；进程不存在或无 /proc 返回 null。 */
export function readStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"))?.starttime ?? null;
  } catch {
    return null;
  }
}

export function newBootToken(): string {
  return randomBytes(16).toString("hex");
}

/** daemon.pid / daemon.lock 的内容：一行 `<pid> <starttime> <token>`（shell 用 read 直接读）。 */
export interface Identity {
  pid: number;
  starttime: string;
  token: string;
}

export function formatIdentity(id: Identity): string {
  return `${id.pid} ${id.starttime} ${id.token}\n`;
}

export function parseIdentity(raw: string): Identity | null {
  const [p, st, tok] = raw.trim().split(/\s+/);
  const pid = Number(p);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (!st || !/^\d+$/.test(st)) return null;
  if (!tok || !/^[A-Za-z0-9]{8,128}$/.test(tok)) return null;
  return { pid, starttime: st, token: tok };
}

/** 本进程身份（Linux 上 starttime 来自 /proc/self/stat；拿不到则抛错——目标运行环境是 Linux）。 */
export function selfIdentity(token: string = newBootToken()): Identity {
  const st = readStartTime(process.pid);
  if (!st) throw new Error("无法读取 /proc/self/stat 的启动时间（需要 Linux /proc）");
  return { pid: process.pid, starttime: st, token };
}

/**
 * 记录的进程是否仍是同一个进程：pid 存在 且 当前 starttime 与记录相同。
 * （pid 被复用 → starttime 不同 → false。）heartbeatToken 给出时还要求与记录的 token 相同。
 */
export function isSameProcessAlive(id: Identity, heartbeatToken?: string): boolean {
  const st = readStartTime(id.pid);
  if (st === null || st !== id.starttime) return false;
  if (heartbeatToken !== undefined && heartbeatToken !== id.token) return false;
  return true;
}
