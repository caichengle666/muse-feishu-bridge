/** config.ts — config.json / secrets.env 的加载与校验（白名单 fail-closed）。 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { PeerBot } from "./mentions.js";

export interface BridgeConfig {
  /** 允许与机器人对话的飞书 open_id。为空时拒绝启动（fail-closed）。 */
  allowedOpenIds?: string[];
  /** `@主人` 转成 @ 提醒的 open_id；缺省取 allowedOpenIds[0]。 */
  ownerOpenId?: string;
  /** 等待助手回复的分钟数，默认 20。 */
  replyTimeoutMin?: number;
  /** 群聊策略：mention（默认，只有 @ 机器人才处理）/ open（群里所有白名单成员的消息都处理）。 */
  groupPolicy?: "mention" | "open";
  /** 出网代理："auto"（默认，读 HTTPS_PROXY / NO_PROXY）、"off"（强制直连）或代理 URL */
  proxy?: string;
  /**
   * 同发送者 + 同会话 + 同文本在 N 秒内只处理一次（默认 0 = 关闭）。
   * 飞书重推用的是同一个 message_id，已由持久化去重覆盖；只有确认看到"不同 message_id 的同一条消息"时才打开，
   * 打开后用户在 N 秒内故意重复发同样的话（如连发两次"好"）也会被合并。
   */
  dedupSameTextSeconds?: number;
  /** feishu（默认）/ lark（国际版）。 */
  domain?: "feishu" | "lark";
  language?: "zh" | "en";
  /** 允许外发的本机文件根目录，默认 [<ROOT>/outgoing, os.tmpdir(), /tmp]。 */
  allowedFileRoots?: string[];
  /** 收到消息后多少秒仍无回复就先发"收到，正在处理"，默认 8；0 关闭。 */
  ackDelaySec?: number;
  /**
   * 回复样式：card（默认）= 统一状态卡片，"处理中"卡原地更新为"已完成"；
   * classic = 旧版（短回复纯文本、长回复才用卡片，另发"收到，正在处理"文字）。
   */
  replyStyle?: "card" | "classic";
  /**
   * 协作机器人（机器人 @ 机器人接力）。登记后：
   *   - 它们在群里 @ 本机器人的消息会被接收（需在飞书开放平台开通
   *     "获取群组中其他机器人和用户@当前机器人的消息"权限 im:message.group_at_msg.include_bot:readonly）；
   *   - 助手回复时可以用 outbox 的 ats 真正 @ 它们。
   * name：称呼；appId：对方 App ID（cli_ 开头，用于识别发送者）；openId：对方在本应用里的 open_id（用 /ids 获取，发 @ 用）。
   */
  peerBots?: PeerBot[];
  /** 同一会话里每分钟最多接收几条机器人发来的消息，默认 6，超出丢弃并记日志 */
  botMaxPerMinute?: number;
  /** 机器人之间最多接力几手，默认 3；到上限后回复不再 @ 机器人 */
  botMaxHops?: number;
  /** 下载用户发来的图片/文件的大小上限（MB），默认 20。 */
  maxDownloadMB?: number;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const s = t.startsWith("export ") ? t.slice(7).trim() : t;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    out[s.slice(0, eq).trim()] = s.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function isPlaceholder(v: string): boolean {
  return !v || /^(your|test_?placeholder|xxx|placeholder|change|cli_xxx$)/i.test(v);
}

/**
 * 读凭证：FEISHU_APP_ID / FEISHU_APP_SECRET；兼容旧示例里的 APP_ID / APP_SECRET。
 * secrets.env 优先，其次进程环境变量。
 */
export async function loadSecrets(path: string, env: NodeJS.ProcessEnv = process.env): Promise<{ appId: string; appSecret: string; source: string }> {
  const file = existsSync(path) ? parseEnvFile(await readFile(path, "utf8")) : {};
  const appId = file.FEISHU_APP_ID || file.APP_ID || env.FEISHU_APP_ID || "";
  const appSecret = file.FEISHU_APP_SECRET || file.APP_SECRET || env.FEISHU_APP_SECRET || "";
  const source = file.FEISHU_APP_ID || file.APP_ID ? "secrets.env" : env.FEISHU_APP_ID ? "环境变量" : "无";
  return { appId, appSecret, source };
}

/** 读 config.json。文件不存在 → {}；JSON 损坏 → 抛错（不静默当空配置）。 */
export async function loadConfig(path: string): Promise<BridgeConfig> {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  try {
    const v: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("顶层必须是对象");
    return v as BridgeConfig;
  } catch (e) {
    throw new Error(`config.json 解析失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface ConfigCheck {
  errors: string[];
  warnings: string[];
}

const isPosNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

export function validateConfig(cfg: BridgeConfig): ConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = cfg.allowedOpenIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string" || !x.trim()))) {
    errors.push("allowedOpenIds 必须是非空字符串数组");
  }
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === "string" && x.trim()) : [];
  if (!list.length) errors.push("allowedOpenIds 为空：请填入允许使用的飞书 open_id（fail-closed）");
  if (list.some((x) => !/^ou_[A-Za-z0-9]+$/.test(x))) warnings.push("allowedOpenIds 里有不像 open_id（ou_ 开头）的值，确认没有填成 user_id / union_id");
  if (cfg.ownerOpenId !== undefined && typeof cfg.ownerOpenId !== "string") errors.push("ownerOpenId 必须是字符串");
  if (cfg.replyTimeoutMin !== undefined && !isPosNum(cfg.replyTimeoutMin)) errors.push("replyTimeoutMin 必须是正数");
  if (cfg.replyStyle !== undefined && cfg.replyStyle !== "card" && cfg.replyStyle !== "classic") errors.push('replyStyle 只能是 "card" 或 "classic"');
  if (cfg.ackDelaySec !== undefined && !(typeof cfg.ackDelaySec === "number" && cfg.ackDelaySec >= 0)) errors.push("ackDelaySec 必须是 ≥0 的数");
  if (cfg.maxDownloadMB !== undefined && !isPosNum(cfg.maxDownloadMB)) errors.push("maxDownloadMB 必须是正数");
  if (cfg.groupPolicy !== undefined && cfg.groupPolicy !== "mention" && cfg.groupPolicy !== "open") errors.push('groupPolicy 只能是 "mention" 或 "open"');
  if (cfg.domain !== undefined && cfg.domain !== "feishu" && cfg.domain !== "lark") errors.push('domain 只能是 "feishu" 或 "lark"');
  if (cfg.allowedFileRoots !== undefined && (!Array.isArray(cfg.allowedFileRoots) || cfg.allowedFileRoots.some((x) => typeof x !== "string" || !x))) {
    errors.push("allowedFileRoots 必须是路径字符串数组");
  }
  if (cfg.proxy !== undefined && cfg.proxy !== "auto" && cfg.proxy !== "off" && !/^https?:\/\/[^\s]+$/i.test(String(cfg.proxy))) errors.push('proxy 只能是 "auto"、"off" 或 http(s):// 开头的代理地址');
  if (cfg.dedupSameTextSeconds !== undefined && !(Number.isFinite(cfg.dedupSameTextSeconds) && cfg.dedupSameTextSeconds >= 0 && cfg.dedupSameTextSeconds <= 600)) errors.push("dedupSameTextSeconds 须为 0–600 的数字");
  if (cfg.peerBots !== undefined) {
    if (!Array.isArray(cfg.peerBots)) errors.push("peerBots 必须是数组");
    else
      cfg.peerBots.forEach((p, i) => {
        if (!p || typeof p.name !== "string" || !p.name.trim()) errors.push(`peerBots[${i}].name 不能为空`);
        if (p?.openId !== undefined && !/^ou_[A-Za-z0-9_-]+$/.test(String(p.openId))) errors.push(`peerBots[${i}].openId 应为 ou_ 开头`);
        if (p?.appId !== undefined && !/^cli_[A-Za-z0-9]+$/.test(String(p.appId))) errors.push(`peerBots[${i}].appId 应为 cli_ 开头`);
        if (p && !p.openId && !p.appId) errors.push(`peerBots[${i}] 至少要填 openId 或 appId`);
        if (p && p.appId && !p.openId) warnings.push(`peerBots[${i}]（${p.name}）没填 openId：能收到它的消息，但回复里 @ 不了它（在群里发 "@本机器人 /ids @${p.name}" 获取）`);
      });
  }
  if (cfg.botMaxPerMinute !== undefined && !isPosNum(cfg.botMaxPerMinute)) errors.push("botMaxPerMinute 必须是正数");
  if (cfg.botMaxHops !== undefined && !(Number.isInteger(cfg.botMaxHops) && cfg.botMaxHops >= 1 && cfg.botMaxHops <= 10)) errors.push("botMaxHops 须为 1–10 的整数");
  if (cfg.groupPolicy === "open") warnings.push("groupPolicy=open：群里白名单成员不 @ 机器人也会触发");
  return { errors, warnings };
}

export function makeIsAllowed(cfg: BridgeConfig): (openId: string) => boolean {
  const list = new Set((cfg.allowedOpenIds || []).filter((x) => typeof x === "string" && x.trim()));
  return (u) => list.has(u);
}
