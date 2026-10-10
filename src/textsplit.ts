/**
 * textsplit.ts — 把一条长回复切成若干段，每段恰好成为一条飞书消息。
 *
 * 原版按 4000 字符、逐行切分：
 *   - 代码块（```）被切成两半，后半段没有开头的 ```，chooseMessageMode 把它判成 post，渲染全乱；
 *   - 单行超过上限时不切，交给 transport 再切，导致"一段"可能变成多条消息，无法做幂等。
 * 现在：
 *   - 默认每段 ≤ 3000 字符（卡片 29KB / post 3500 字符的限制内，保证一段只产生一条消息）；
 *   - 优先在空行、其次在换行处切；超长单行按字符切（不切断代理对）；
 *   - 切点落在代码块内部时，本段末尾补 ``` 收尾，下一段开头补上原来的 ```lang。
 */
export const REPLY_CHUNK_CHARS = 3000;

const FENCE_RE = /^\s*(```+|~~~+)(.*)$/;

const KEEP_TOGETHER = "@主人";

function hardSplit(line: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  let n = 0;
  for (const ch of line) {
    const l = ch.length;
    if (n + l > max && cur) {
      // 不把 "@主人" 切成两半（否则两段都替换不成 @ 提醒）
      const k = cur.lastIndexOf("@");
      if (k > 0 && cur.length - k < KEEP_TOGETHER.length && KEEP_TOGETHER.startsWith(cur.slice(k) + ch)) {
        out.push(cur.slice(0, k));
        cur = cur.slice(k);
      } else {
        out.push(cur);
        cur = "";
      }
      n = cur.length;
    }
    cur += ch;
    n += l;
  }
  if (cur) out.push(cur);
  return out;
}

export function splitReplyText(text: string, maxChars: number = REPLY_CHUNK_CHARS): string[] {
  if (maxChars < 64) throw new Error("maxChars 至少 64");
  const src = text.replace(/\r\n/g, "\n");
  if (!src.trim()) return [];
  if (src.length <= maxChars) return [src];

  const budget = maxChars - 8; // 给补上的 ``` 留余量
  const lines: string[] = [];
  for (const l of src.split("\n")) {
    if (l.length > budget) lines.push(...hardSplit(l, budget));
    else lines.push(l);
  }

  const out: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let fence: string | null = null; // 当前所在代码块的开头行（如 ```python）
  let fenceAtChunkStart: string | null = null;
  let lastBlank = -1; // cur 里最后一个"代码块外空行"的下标

  const flush = (upto: number, fenceForTail: string | null) => {
    const head = cur.slice(0, upto);
    const tail = cur.slice(upto);
    let body = head.join("\n");
    if (fenceForTail) body += "\n```";
    if (body.trim()) out.push(body);
    cur = fenceForTail ? [fenceForTail, ...tail] : tail;
    curLen = cur.reduce((a, l) => a + l.length + 1, 0);
    fenceAtChunkStart = fenceForTail;
    lastBlank = -1;
  };

  for (const line of lines) {
    if (curLen + line.length + 1 > budget && cur.length) {
      if (fence === null && lastBlank > 0 && lastBlank >= cur.length * 0.5) {
        flush(lastBlank, null);
        // 去掉新段开头的空行
        while (cur.length && !cur[0].trim()) cur.shift();
        curLen = cur.reduce((a, l) => a + l.length + 1, 0);
      } else {
        flush(cur.length, fence);
      }
    }
    cur.push(line);
    curLen += line.length + 1;
    const m = line.match(FENCE_RE);
    if (m) fence = fence === null ? line.trim() : null;
    else if (fence === null && !line.trim()) lastBlank = cur.length - 1;
  }
  void fenceAtChunkStart;
  if (cur.length) {
    const body = cur.join("\n");
    if (body.trim()) out.push(body);
  }
  return out;
}
