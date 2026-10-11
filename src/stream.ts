/**
 * stream.ts — 流式输出（打字机效果）的文件协议。
 *
 * worker 生成长回复时，边写边往 stream/<messageId>.jsonl 追加一行一段：
 *   {"text":"第一段……\n\n"}
 *   {"text":"第二段……"}
 * 各段按原样首尾相接（不额外插分隔符，换行由 worker 自己写进 text），
 * daemon 每秒把累计全文推到这条消息的状态卡上：
 *   - 状态卡是 CardKit 卡片实体（有 cardkit:card:write 权限）→ 飞书原生打字机动画；
 *   - 否则 → PATCH 普通卡片，逐段刷新（没有动画，但能看到进度）。
 * 最终仍以 outbox/<id>.json 为准：它到达后卡片被更新为完整的最终回复，stream 文件删除。
 */
import { REPLY_CHUNK_CHARS } from "./textsplit.js";

/** 流式期间卡片上最多显示多少字（与最终回复第一段的切分长度一致，超出部分最终分段发出）。 */
export const STREAM_DISPLAY_CHARS = REPLY_CHUNK_CHARS;
export const STREAM_MORE_NOTE = "\n\n…（内容较长，写完后分段完整发出）";

/** 解析 stream 文件：逐行 JSON {text}，坏行（含正在写的半行）忽略。 */
export function parseStreamText(raw: string): { text: string; done: boolean } {
  let text = "";
  let done = false;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as unknown;
      if (!o || typeof o !== "object" || Array.isArray(o)) continue;
      const r = o as Record<string, unknown>;
      if (typeof r.text === "string") text += r.text;
      if (r.done === true) done = true;
    } catch {
      /* 半行或坏行 */
    }
  }
  return { text, done };
}

/**
 * 流式期间卡片显示的文本：超过上限时截在上限处并加提示（保持前缀稳定，打字机才能接着往下打）。
 * 截断处如果正好在代码块里，补上闭合围栏，免得后面的提示被当成代码。
 */
export function streamDisplayText(full: string): { text: string; truncated: boolean } {
  const chars = [...full];
  if (chars.length <= STREAM_DISPLAY_CHARS) return { text: full, truncated: false };
  let head = chars.slice(0, STREAM_DISPLAY_CHARS).join("");
  const fences = (head.match(/^\s*```/gm) || []).length;
  if (fences % 2 === 1) head += "\n```";
  return { text: head + STREAM_MORE_NOTE, truncated: true };
}
