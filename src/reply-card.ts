/**
 * reply-card.ts — 统一的回复卡片（飞书卡片 JSON 2.0）。
 *
 * 样式：彩色状态标题 + Markdown 正文 + 灰色小字页脚。
 *   处理中（蓝）→ 已完成（绿），同一张卡原地更新（PATCH），不再多发一条"收到，正在处理"。
 *   仍在处理（橙）、已超时 / 发送失败（红）、命令回复（靛蓝）。
 * 参考：caichengle666/omp-feishu-lark 的状态卡（状态色标题）、hermes-feishu-streaming-card 的页脚。
 */

import { applyAts, type AtTarget } from "./mentions.js";

export type CardStatus = "running" | "slow" | "done" | "timeout" | "failed" | "info" | "stopped";

const HEAD: Record<CardStatus, { title: string; template: string }> = {
  running: { title: "⏳ 处理中", template: "blue" },
  slow: { title: "⏳ 仍在处理", template: "orange" },
  done: { title: "✅ 已完成", template: "green" },
  timeout: { title: "⚠️ 已超时", template: "red" },
  failed: { title: "❌ 出错了", template: "red" },
  info: { title: "ℹ️ 信息", template: "indigo" },
  stopped: { title: "⏹️ 已停止", template: "grey" },
};

export interface ReplyCardInput {
  status: CardStatus;
  markdown: string;
  /** 覆盖默认标题 */
  title?: string;
  /** 页脚（灰色小字），多项用 " · " 连接 */
  footer?: string[];
  /** 多段回复的段号（1 基） */
  part?: { index: number; total: number };
  /** 把 "@主人" 换成卡片里的 @ 提醒（兼容旧参数） */
  atOpenId?: string;
  /** @ 目标：正文 "@名字" 换成 @ 标签，prefix 的在开头补 */
  ats?: AtTarget[];
  /** 卡片实体的流式模式（CardKit 打字机效果） */
  streaming?: boolean;
}

/** 正文 markdown 组件的 element_id（CardKit 流式更新按它定位） */
export const CONTENT_ELEMENT_ID = "content";

export function buildReplyCard(input: ReplyCardInput): Record<string, unknown> {
  const head = HEAD[input.status];
  let title = input.title || head.title;
  if (input.part && input.part.total > 1) title += `（${input.part.index}/${input.part.total}）`;
  let md = (input.markdown || "").trim() || " ";
  const ats = [...(input.ats || []), ...(input.atOpenId ? [{ id: input.atOpenId, name: "主人" }] : [])];
  if (ats.length) md = applyAts(md, ats, "card");
  const footer = (input.footer || []).filter(Boolean).join(" · ");
  const elements: Record<string, unknown>[] = [{ tag: "markdown", element_id: CONTENT_ELEMENT_ID, content: md }];
  if (footer) {
    elements.push({ tag: "markdown", content: `<font color='grey'>${escapeFooter(footer)}</font>`, text_size: "notation" });
  }
  const config: Record<string, unknown> = { update_multi: true, summary: { content: summaryOf(input.markdown) || title } };
  if (input.streaming) {
    config.streaming_mode = true;
    config.streaming_config = { print_frequency_ms: { default: 50 }, print_step: { default: 2 }, print_strategy: "fast" };
  }
  return {
    schema: "2.0",
    config,
    header: { title: { tag: "plain_text", content: title }, template: head.template },
    body: { elements },
  };
}

/** 会话列表里的预览文字（否则只显示"[卡片]"）。 */
function summaryOf(md: string): string {
  const s = (md || "")
    .replace(/```[\s\S]*?```/g, "[代码]")
    .replace(/[#>*_`|]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return [...s].slice(0, 60).join("");
}

function escapeFooter(s: string): string {
  return s.replace(/</g, "＜").replace(/>/g, "＞");
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  return `${Math.floor(m / 60)}小时${m % 60}分`;
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
