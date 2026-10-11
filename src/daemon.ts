#!/usr/bin/env node
/**
 * daemon.ts — 飞书 × Muse 桥接 daemon（进程级胶水）。
 *
 * 加载并校验配置（白名单 fail-closed）→ 单实例锁（O_EXCL daemon.lock，pid + starttime + token）
 * → pid 文件 / 心跳 → 崩溃恢复（inflight/ → outbox/）→ 建立飞书长连接 → 把事件交给 bridge.ts。
 * 全部业务逻辑在 bridge.ts / outbox.ts，可离线测试。
 *
 * 凭证：secrets.env（600）里的 FEISHU_APP_ID / FEISHU_APP_SECRET（兼容 APP_ID / APP_SECRET）。
 */
import { mkdir } from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FeishuTransport } from "./transport.js";
import { MuseBackend } from "./muse-backend.js";
import { makePaths, resolveRoot } from "./paths.js";
import { isPlaceholder, loadConfig, loadSecrets, validateConfig, type BridgeConfig } from "./config.js";
import { debugLog, flushDebugLog, setDebugLogPath } from "./debug.js";
import { CardEventDedupe, ChatRegistry, HeartbeatWriter, RouteStore, SeenStore, removePidFileSync, writePidFile } from "./state.js";
import { selfIdentity } from "./proc.js";
import { acquireInstanceLock, releaseInstanceLock } from "./lock.js";
import { OutboxStore } from "./outbox.js";
import { createBridge } from "./bridge.js";
import { resolveAllowedRoots } from "./files.js";
import { chooseProxy } from "./proxy.js";
import { feishuCodeOf } from "./feishu-retry.js";
import { errText } from "./fsutil.js";

function pkgVersion(): string {
  try {
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    return String(JSON.parse(readFileSync(p, "utf8")).version || "dev");
  } catch {
    return "dev";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check-config");
  const paths = makePaths(resolveRoot());

  const fail = (msg: string, code = 2): never => {
    console.error(`${checkOnly ? "配置检查失败" : "daemon 启动失败"}: ${msg}`);
    process.exit(code);
  };

  let cfg: BridgeConfig = {};
  try {
    cfg = await loadConfig(paths.config);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const secrets = await loadSecrets(paths.secrets);
  if (isPlaceholder(secrets.appId) || isPlaceholder(secrets.appSecret)) {
    fail(`缺少 FEISHU_APP_ID / FEISHU_APP_SECRET（${paths.secrets}，也兼容 APP_ID / APP_SECRET）`);
  }
  const check = validateConfig(cfg);
  for (const w of check.warnings) console.warn(`警告: ${w}`);
  if (check.errors.length) fail(check.errors.join("；"));
  try {
    const mode = statSync(paths.secrets).mode & 0o077;
    if (mode) console.warn(`警告: ${paths.secrets} 权限过宽，建议 chmod 600`);
  } catch {
    /* 用的是环境变量 */
  }

  if (checkOnly) {
    console.log("配置检查通过（未连接飞书）。");
    console.log(`  ROOT=${paths.root}`);
    console.log(`  凭证来源: ${secrets.source}`);
    console.log(`  白名单: ${(cfg.allowedOpenIds || []).join(",")}`);
    console.log(`  群聊策略: ${cfg.groupPolicy || "mention"}`);
    console.log(`  出网: ${chooseProxy(cfg.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn", cfg.proxy).label}`);
    console.log(`  允许外发文件目录: ${resolveAllowedRoots(paths.root, cfg.allowedFileRoots).join(", ")}`);
    process.exit(0);
  }

  // 同一 App 多条长连接时飞书会把事件随机分给其中一条，两个实例还会各自排空 outbox → 重复回复。
  // daemon 自己用 O_EXCL 创建 daemon.lock，手动 npm start 也绕不过。
  await mkdir(paths.root, { recursive: true });
  const self = selfIdentity();
  const lock = acquireInstanceLock(paths.lock, self);
  if (!lock.ok) return fail(`${lock.reason}（见 ${paths.lock}）`, 1);
  process.on("exit", () => {
    removePidFileSync(paths.pid, self);
    releaseInstanceLock(paths.lock, self);
  });
  const earlyExit = () => process.exit(0);
  process.on("SIGINT", earlyExit);
  process.on("SIGTERM", earlyExit);
  await writePidFile(paths.pid, self);

  setDebugLogPath(paths.debugLog);
  const log = debugLog;
  if (lock.reclaimed) log("daemon.lock_reclaimed", {});

  const backend = new MuseBackend({ inbox: paths.inbox, expired: paths.expired });
  await backend.init();
  const outbox = new OutboxStore({
    outbox: paths.outbox,
    sent: paths.sent,
    failed: paths.failed,
    expired: paths.expired,
    progress: paths.progress,
    inflight: paths.inflight,
  });
  await outbox.init();
  for (const dir of [paths.incoming, paths.outgoing, paths.stream]) await mkdir(dir, { recursive: true });
  const recovered = await outbox.recoverInflight();
  if (recovered.requeued.length || recovered.expired.length) log("daemon.inflight_recovered", recovered);

  const seen = new SeenStore(paths.seen);
  await seen.load();
  const routes = new RouteStore(paths.routes);
  routes.loadSync();
  const cardEvents = new CardEventDedupe(paths.cardEvents);
  cardEvents.loadSync();
  // 上一个 daemon 最后一次心跳的时刻：重启后从这里开始补拉断线期间的消息
  const prevAliveAt = readHeartbeatTs(paths.heartbeat);
  const chats = new ChatRegistry(paths.chats);
  chats.loadSync();
  const heartbeat = new HeartbeatWriter(paths.heartbeat, process.pid, Date.now, self.token);
  await heartbeat.init();

  let bridge: ReturnType<typeof createBridge> | undefined;
  const transport = new FeishuTransport(
    {
      appId: secrets.appId,
      appSecret: secrets.appSecret,
      domain: cfg.domain || "feishu",
      groupPolicy: cfg.groupPolicy || "mention",
      language: cfg.language || "zh",
      // 始终放行到上层，由 bridge 按运行中的协作机器人名单过滤（/ids 卡片登记的新机器人不用重启就能收）
      acceptBotMessages: true,
      ...(cfg.proxy ? { proxy: cfg.proxy } : {}),
    },
    async (msg) => {
      if (msg.senderType !== "bot") chats.touch(msg.chatId, msg.chatType);
      await bridge?.onMessage(msg);
    },
    async (action) => bridge?.onCardAction(action),
  );
  const envMs = (k: string) => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  bridge = createBridge({
    transport, paths, config: cfg, backend, outbox, seen, routes, cardEvents, heartbeat, log,
    version: pkgVersion(),
    // 仅供联调 / 测试缩短巡检周期
    sweepIntervalMs: envMs("MUSE_FEISHU_SWEEP_MS"),
  });

  // 断线补拉：重启 / 重连后把最近活跃会话里断线期间的消息拉回来，走正常处理路径（已处理的按 message_id 跳过）
  const backfillMin = cfg.backfillMinutes ?? 30;
  let groupBackfillDenied = false;
  const runBackfill = async (downSince: number | undefined, reason: string) => {
    if (!backfillMin || !downSince) return;
    const now = Date.now();
    const since = Math.max(downSince - 60_000, now - backfillMin * 60_000);
    let checked = 0;
    const errors: string[] = [];
    for (const c of chats.recent(7 * 24 * 3600_000, 20)) {
      if (c.chatType === "group" && groupBackfillDenied) continue;
      try {
        checked += await transport.backfillChat(c.chatId, c.chatType, since);
      } catch (e) {
        const code = feishuCodeOf(e);
        if (c.chatType === "group" && (code === 230027 || code === 99991672)) groupBackfillDenied = true;
        errors.push(`${c.chatId}: ${errText(e)}`);
      }
    }
    log("daemon.backfill", {
      reason,
      since: new Date(since).toISOString(),
      downSec: Math.round((now - downSince) / 1000),
      truncated: now - downSince > backfillMin * 60_000,
      checked,
      ...(errors.length ? { errors: errors.slice(0, 5) } : {}),
    });
  };
  transport.onReconnected((downSince) => void runBackfill(downSince, "reconnect"));

  const shutdown = () => {
    log("daemon.shutdown", {});
    bridge?.stopTimers();
    void transport
      .stop()
      .catch(() => undefined)
      .then(() => flushDebugLog())
      .finally(() => process.exit(0));
  };
  process.off("SIGINT", earlyExit);
  process.off("SIGTERM", earlyExit);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await transport.start();
  await heartbeat.setConnected(true);
  bridge.startTimers();
  console.log(`muse-feishu daemon 已启动（pid ${process.pid}），飞书长连接就绪。`);
  log("daemon.started", { pid: process.pid });
  void runBackfill(prevAliveAt, "restart");
}

function readHeartbeatTs(path: string): number | undefined {
  try {
    const ts = Number((JSON.parse(readFileSync(path, "utf8")) as { ts?: unknown }).ts);
    return Number.isFinite(ts) && ts > 0 ? ts : undefined;
  } catch {
    return undefined;
  }
}

main().catch(async (e: unknown) => {
  console.error("daemon 启动失败:", e instanceof Error ? e.message : e);
  await flushDebugLog().catch(() => undefined);
  process.exit(1);
});
