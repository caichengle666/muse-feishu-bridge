export type Domain = "feishu" | "lark";
export type GroupPolicy = "open" | "mention";
export type FeishuConfig = {
  appId: string;
  appSecret: string;
  domain: Domain;
  groupPolicy: GroupPolicy;
  /** "auto"（默认，读 HTTPS_PROXY/NO_PROXY）| "off" | 代理 URL */
  proxy?: string;
  language?: "zh" | "en";
  /** 是否把其他机器人发来的消息交给上层（由 bridge 按协作机器人名单过滤） */
  acceptBotMessages?: boolean;
  reactEmoji?: string;
};

export type FeishuMessage = {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  chatMode?: "p2p" | "group" | "topic";
  senderOpenId: string;
  msgType: string;
  content: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  mentions?: unknown[];
  /** user（默认）/ bot：机器人发来的（仅当配置了 peerBots 才会转交上层） */
  senderType?: "user" | "bot";
  /** 机器人发送者的 App ID（若事件提供） */
  senderAppId?: string;
  /** 飞书消息创建时间（毫秒字符串） */
  createTime?: string;
};

export type FeishuAttachment = {
  kind: "image" | "file" | "audio";
  fileKey: string;
  fileName?: string;
};

export type FeishuCardAction = {
  messageId: string;
  chatId?: string;
  operatorOpenId: string;
  /** 回调事件 id（用于去重；WS 推送里有） */
  eventId?: string;
  token?: string;
  value: unknown;
  formValue?: Record<string, unknown>;
};

