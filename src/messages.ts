import type { FeishuAttachment, FeishuMessage } from "./types.js";

type PostBody = {
  title?: string;
  content?: unknown[];
};

export function parseMessageInput(msg: FeishuMessage, botOpenId?: string): { text: string; attachments: FeishuAttachment[] } {
  const attachments: FeishuAttachment[] = [];
  try {
    const json = JSON.parse(msg.content || "{}");
    if (msg.msgType === "text") {
      let text = String(json.text || "");
      if (botOpenId) text = text.replace(new RegExp(`@?${botOpenId}`, "g"), "");
      return { text: text.trim(), attachments };
    }
    if (msg.msgType === "post") {
      const post = json.post || json;
      const locale = resolvePostBody(post);
      const parts: string[] = [];
      if (typeof locale?.title === "string" && locale.title.trim()) {
        parts.push(locale.title.trim());
      }
      for (const para of locale?.content || []) {
        const paragraphText = extractPostText(para, attachments, botOpenId).trim();
        if (paragraphText) parts.push(paragraphText);
      }
      collectAttachments(json, attachments);
      return { text: parts.join("\n").trim(), attachments };
    }
    if (msg.msgType === "image" && typeof json.image_key === "string" && json.image_key) {
      attachments.push({ kind: "image", fileKey: json.image_key });
      collectAttachments(json, attachments);
      return { text: "", attachments };
    }
    if (msg.msgType === "file" && typeof json.file_key === "string" && json.file_key) {
      attachments.push({
        kind: "file",
        fileKey: json.file_key,
        fileName: typeof json.file_name === "string" ? json.file_name : undefined,
      });
      collectAttachments(json, attachments);
      return { text: "", attachments };
    }
    if (msg.msgType === "audio" && typeof json.file_key === "string" && json.file_key) {
      attachments.push({ kind: "audio", fileKey: json.file_key, fileName: "audio.ogg" });
      return { text: "", attachments };
    }
    collectAttachments(json, attachments);
    if (attachments.length) return { text: "", attachments };
  } catch {}
  return { text: msg.msgType === "text" ? msg.content : `[${msg.msgType}]`, attachments };
}

function resolvePostBody(post: unknown): PostBody | undefined {
  if (isPostBody(post)) return post;
  if (!post || typeof post !== "object" || Array.isArray(post)) return undefined;

  const record = post as Record<string, unknown>;
  const candidates = [record.zh_cn, record.en_us, ...Object.values(record)];
  return candidates.find(isPostBody);
}

function isPostBody(value: unknown): value is PostBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.content);
}

function extractPostText(node: unknown, attachments: FeishuAttachment[], botOpenId?: string): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map((item) => extractPostText(item, attachments, botOpenId)).join("");

  const obj = node as Record<string, unknown>;
  const tag = typeof obj.tag === "string" ? obj.tag : undefined;

  if ((tag === "img" || tag === "image") && typeof obj.image_key === "string" && obj.image_key) {
    attachments.push({ kind: "image", fileKey: obj.image_key });
    return "";
  }

  if (tag === "at") {
    const name = `@${typeof obj.user_name === "string" && obj.user_name ? obj.user_name : "user"}`;
    return botOpenId && (obj.user_id === botOpenId || obj.open_id === botOpenId) ? `${name}（你）` : name;
  }

  if ((tag === "text" || tag === "a") && typeof obj.text === "string") {
    return obj.text;
  }

  if (typeof obj.text === "string") return obj.text;

  return Object.values(obj).map((item) => extractPostText(item, attachments, botOpenId)).join("");
}

function collectAttachments(value: unknown, attachments: FeishuAttachment[]) {
  const seen = new Set(attachments.map((item) => `${item.kind}:${item.fileKey}`));
  walk(value);

  function add(attachment: FeishuAttachment) {
    const key = `${attachment.kind}:${attachment.fileKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    attachments.push(attachment);
  }

  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const obj = node as Record<string, unknown>;
    if (typeof obj.image_key === "string" && obj.image_key) {
      add({ kind: "image", fileKey: obj.image_key });
    }
    if (typeof obj.file_key === "string" && obj.file_key) {
      add({
        kind: "file",
        fileKey: obj.file_key,
        fileName: typeof obj.file_name === "string" ? obj.file_name : undefined,
      });
    }

    for (const item of Object.values(obj)) walk(item);
  }
}
