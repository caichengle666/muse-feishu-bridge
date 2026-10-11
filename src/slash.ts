/**
 * 斜杠命令：白名单通过后、入队之前拦截，daemon 直接回复，不进 inbox、不唤醒助手。
 *
 * 只拦截已登记的命令。未登记的 "/xxx"（例如用户发 "/tmp/a.log 帮我看下"）照常交给助手，
 * 不会被当成"未知命令"吞掉。新增命令：在 COMMANDS 里加一项。
 */
import { readdir } from "node:fs/promises";
import type { Paths } from "./paths.js";

export interface SlashCommand {
  name: string;
  args: string;
}

export function parseSlashCommand(text: string): SlashCommand | null {
  const t = (text || "").trim();
  const m = /^\/([a-zA-Z][\w-]{0,31})(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

export interface SlashContext {
  chatType: string;
  paths: Paths;
  isRunning: () => boolean;
  startedAt: number;
  now: () => number;
  version: string;
  /** /ids 用：发送者 open_id、消息里被 @ 的人/机器人（不含本机器人） */
  senderOpenId?: string;
  mentions?: { openId: string; name: string }[];
  /** /new 用：清空当前会话的历史，返回 false = 本来就没有 */
  clearHistory?: () => Promise<boolean>;
  /** 历史功能是否开启 */
  historyEnabled?: boolean;
}

async function count(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.endsWith(".reason.json") && !f.endsWith(".partial.json")).length;
  } catch {
    return 0;
  }
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}天${h}小时` : h ? `${h}小时${m}分` : `${m}分${s % 60}秒`;
}

type Handler = (ctx: SlashContext, args: string) => Promise<string> | string;

const COMMANDS: Record<string, { desc: string; run: Handler }> = {
  help: {
    desc: "显示本帮助",
    run: () => "可用命令：\n" + Object.entries(COMMANDS).map(([k, v]) => `/${k} - ${v.desc}`).join("\n"),
  },
  ping: { desc: "测试连通性", run: () => "pong 🏓" },
  ids: {
    desc: "查看 open_id（本应用视角）：/ids @某人 @某机器人",
    run: (ctx) =>
      [
        `你：${ctx.senderOpenId || "未知"}`,
        ...(ctx.mentions || []).map((m) => `${m.name || "某人"}：${m.openId}`),
        ...((ctx.mentions || []).length ? [] : ["（在命令后面 @ 要查的人或机器人）"]),

      ].join("\n"),
  },
  new: {
    desc: "清空本会话的上下文，从头开始聊",
    run: async (ctx) => {
      if (!ctx.historyEnabled || !ctx.clearHistory) return "上下文功能已关闭（historyTurns = 0），每条消息本来就是独立处理的。";
      return (await ctx.clearHistory()) ? "已清空本会话的上下文，接下来从头开始。" : "本会话还没有上下文记录，不用清。";
    },
  },
  status: {
    desc: "查看桥接状态",
    run: async (ctx) =>
      [
        `muse-feishu-bridge ${ctx.version}`,
        `长连接: ${ctx.isRunning() ? "正常" : "断开"}`,
        `已运行: ${fmtDuration(ctx.now() - ctx.startedAt)}`,
        `待处理: inbox ${await count(ctx.paths.inbox)}，待发送 ${await count(ctx.paths.outbox)}，发送中 ${await count(ctx.paths.inflight)}`,
        `发送失败: ${await count(ctx.paths.failed)}（7 天内）`,
        `会话类型: ${ctx.chatType}`,
        `时间: ${new Date(ctx.now()).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
      ].join("\n"),
  },
};

/** 是已登记命令则返回回复文本，否则返回 null（交给助手）。 */
export async function runSlashCommand(cmd: SlashCommand, ctx: SlashContext): Promise<string | null> {
  const c = Object.prototype.hasOwnProperty.call(COMMANDS, cmd.name) ? COMMANDS[cmd.name] : undefined;
  if (!c) return null;
  return c.run(ctx, cmd.args);
}
