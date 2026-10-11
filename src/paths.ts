/**
 * paths.ts — 运行目录（ROOT）与各子路径。
 * ROOT 默认是编译产物 dist/ 的上一级（仓库目录），可用环境变量 MUSE_FEISHU_ROOT 覆盖。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Paths {
  root: string;
  config: string;
  secrets: string;
  seen: string;
  routes: string;
  cardEvents: string;
  chats: string;
  heartbeat: string;
  pid: string;
  lock: string;
  debugLog: string;
  inbox: string;
  outbox: string;
  inflight: string;
  progress: string;
  sent: string;
  failed: string;
  expired: string;
  /** /stop 标记：stop/<会话>.json，worker 每步动手前查 */
  stop: string;
  /** 流式输出：stream/<messageId>.jsonl，worker 边写边追加，daemon 推到卡片 */
  stream: string;
  incoming: string;
  outgoing: string;
}

export function resolveRoot(env: NodeJS.ProcessEnv = process.env, moduleUrl: string = import.meta.url): string {
  const fromEnv = (env.MUSE_FEISHU_ROOT || "").trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(dirname(fileURLToPath(moduleUrl)), ".."));
}

export function makePaths(root: string): Paths {
  const r = resolve(root);
  return {
    root: r,
    config: join(r, "config.json"),
    secrets: join(r, "secrets.env"),
    seen: join(r, "seen.json"),
    routes: join(r, "routes.json"),
    cardEvents: join(r, "card_events.json"),
    chats: join(r, "chats.json"),
    heartbeat: join(r, "heartbeat.json"),
    pid: join(r, "daemon.pid"),
    lock: join(r, "daemon.lock"),
    debugLog: join(r, "debug.log"),
    inbox: join(r, "inbox"),
    outbox: join(r, "outbox"),
    inflight: join(r, "inflight"),
    progress: join(r, "progress"),
    sent: join(r, "sent"),
    failed: join(r, "failed"),
    expired: join(r, "expired"),
    stop: join(r, "stop"),
    stream: join(r, "stream"),
    incoming: join(r, "incoming"),
    outgoing: join(r, "outgoing"),
  };
}
