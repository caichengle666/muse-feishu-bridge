/**
 * debug.ts — 结构化 JSONL 调试日志（fire-and-forget，永不抛错）。
 * - 敏感键（content/text/token/secret/password/authorization/prompt/output）一律打码；
 * - 批量追加，按大小轮转（默认 10MB，保留 debug.log.1），权限 600；
 * - 路径由 daemon 启动时 setDebugLogPath() 指定，测试可指向临时目录或关闭。
 */
import { appendFile, chmod, rename, stat } from "node:fs/promises";

const MAX_VALUE_LENGTH = 1200;
const FLUSH_DELAY_MS = 25;
let logPath: string | null = null;
let maxBytes = 10 * 1024 * 1024;
let size = -1;
const pending: string[] = [];
let flushTimer: NodeJS.Timeout | undefined;
let flushing: Promise<void> | undefined;
export type LogFn = (event: string, details?: Record<string, unknown>) => void;
type Sink = LogFn;
let sink: Sink | null = null;

export function setDebugLogPath(path: string | null, opts: { maxBytes?: number } = {}): void {
  logPath = path;
  size = -1;
  if (opts.maxBytes) maxBytes = opts.maxBytes;
}

export function debugLog(event: string, details?: Record<string, unknown>): void {
  try {
    const safe = details ? (truncate(details) as Record<string, unknown>) : undefined;
    if (sink) sink(event, safe);
    if (!logPath) return;
    pending.push(JSON.stringify({ at: new Date().toISOString(), event, ...(safe ? { details: safe } : {}) }));
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        void flushDebugLog();
      }, FLUSH_DELAY_MS);
      flushTimer.unref?.();
    }
  } catch {
    /* 日志永不影响主流程 */
  }
}

export async function flushDebugLog(): Promise<void> {
  if (flushing) await flushing;
  if (!pending.length || !logPath) return;
  const lines = pending.splice(0, pending.length);
  flushing = writeBatch(logPath, lines);
  try {
    await flushing;
  } finally {
    flushing = undefined;
  }
  if (pending.length) await flushDebugLog();
}

async function writeBatch(path: string, lines: string[]): Promise<void> {
  try {
    const data = `${lines.join("\n")}\n`;
    const bytes = Buffer.byteLength(data, "utf8");
    if (size < 0) size = await stat(path).then((s) => s.size, () => 0);
    if (size > 0 && size + bytes > maxBytes) {
      await rename(path, path + ".1").catch(() => undefined);
      size = 0;
    }
    await appendFile(path, data, { encoding: "utf8", mode: 0o600 });
    if (size === 0) await chmod(path, 0o600).catch(() => undefined);
    size += bytes;
  } catch {
    /* ignore */
  }
}

const SECRET_KEY = /(?:authorization|content|password|prompt|secret|text|token|output)/i;

function truncate(value: unknown, key?: string, depth = 0): unknown {
  if (key && SECRET_KEY.test(key)) return "[redacted]";
  if (depth > 6) return "[deep]";
  if (typeof value === "string") return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}...` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => truncate(item, key, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncate(v, k, depth + 1);
    return out;
  }
  return value;
}
