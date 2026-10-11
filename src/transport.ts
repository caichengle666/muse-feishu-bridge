import { readFileSync, statSync } from "node:fs";
import { applyAts, type AtTarget } from "./mentions.js";
import { basename, extname } from "node:path";
import type { FeishuCardAction, FeishuConfig, FeishuMessage } from "./types.js";
import { applyAxiosProxy, chooseProxy, makeProxyAgent } from "./proxy.js";
import type { Client, WSClient } from "@larksuiteoapi/node-sdk";
import { detectImageMime } from "./attachments.js";
import { debugLog } from "./debug.js";
import { buildMarkdownCardParts, buildPostMessages, chooseMessageMode } from "./rich-text.js";
import { withFeishuRetry } from "./feishu-retry.js";

const TEXT_CHUNK_MAX_BYTES = 120 * 1024;
const REST_TIMEOUT_MS = 15_000;
const WS_READY_TIMEOUT_MS = 30_000;
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_FILE_UPLOAD_BYTES = 30 * 1024 * 1024;
type RuntimeWSClient = WSClient & {
  close?: (options?: { force?: boolean }) => void;
  stop?: () => Promise<void> | void;
};
type RuntimeSdkClient = Client & { httpInstance?: { defaults?: { timeout?: number } } };

export class BotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotUnavailableError";
  }
}

export class FeishuTransport {
  private sdkClient: Client | undefined;
  private wsClient: RuntimeWSClient | undefined;
  private running = false;
  private wsDisconnects = 0;
  /** 本次断线开始的时刻（重连成功后清空），供断线补拉确定起点 */
  private downSince: number | undefined;
  private reconnectedListener: ((downSince: number | undefined) => void) | undefined;
  private botOpenId: string | undefined;
  private readonly chatModeCache = new Map<string, "p2p" | "group" | "topic">();

  constructor(
    private readonly config: FeishuConfig,
    private readonly onMessage: (msg: FeishuMessage) => Promise<void>,
    private readonly onCardAction: (action: FeishuCardAction) => Promise<object | undefined | void>,
  ) {}

  async start() {
    if (this.running) return;
    const lark = await import("@larksuiteoapi/node-sdk");
    const domain = this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
    const proxy = chooseProxy(this.config.domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn", this.config.proxy);
    const agent = proxy.url ? makeProxyAgent(proxy.url) : undefined;
    // REST 与长连接握手前的 pullConnectConfig 都走 SDK 的 defaultHttpInstance（axios）
    const http = (lark as unknown as { defaultHttpInstance?: { defaults: Record<string, unknown> } }).defaultHttpInstance;
    if (http) applyAxiosProxy(http.defaults, agent);
    debugLog("feishu.proxy", { via: proxy.label, source: proxy.source });

    this.sdkClient = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: lark.AppType.SelfBuild,
      domain,
      loggerLevel: lark.LoggerLevel.error,
    });
    configureSdkRestTimeout(this.sdkClient);

    await this.probeBotOpenId();

    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      "im.message.receive_v1": async (data: unknown) => this.handleRawMessage(data),
      "im.message.reaction.created_v1": async () => undefined,
      "im.chat.member.bot.added_v1": async () => undefined,
    });

    // Always register the WS card action handler. When the app is connected
    // via WebSocket (which is always the case with WSClient), the Feishu
    // platform delivers card action callbacks through the WS channel.
    // Without this handler the EventDispatcher returns an invalid response
    // to the platform, causing error 200672 on the client.
    dispatcher.register({
      "card.action.trigger": async (data: unknown) => this.handleCardAction(data),
    });


    const ready = createWsReadyGate(WS_READY_TIMEOUT_MS);
    this.wsClient = new lark.WSClient({
      ...(agent ? { agent } : {}),
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.error,
      // 静默断线：TCP 没断但服务端已不再推送（NAT/代理超时常见）。发 ping 后 30 秒内没有任何入站帧就判定死连接、
      // 主动断开走重连；握手 20 秒没完成也重试（默认无上限，DNS/代理卡住时会一直挂着）。
      wsConfig: { pingTimeout: 30 },
      handshakeTimeoutMs: 20_000,
      onReady: () => {
        this.running = true;
        ready.resolve();
      },
      onError: (error) => {
        this.running = false;
        this.downSince ??= Date.now();
        this.wsDisconnects += 1;
        debugLog("feishu.ws.disconnected", { count: this.wsDisconnects, error: error.message });
        ready.reject(error);
      },
      onReconnecting: () => {
        this.running = false;
        this.downSince ??= Date.now();
        debugLog("feishu.ws.reconnecting", { count: this.wsDisconnects });
      },
      onReconnected: () => {
        this.running = true;
        debugLog("feishu.ws.reconnected", { at: new Date().toISOString() });
        const since = this.downSince;
        this.downSince = undefined;
        this.reconnectedListener?.(since);
      },
    });

    try {
      await this.wsClient.start({ eventDispatcher: dispatcher });
      await ready.promise;
      debugLog("feishu.ws.connected", { at: new Date().toISOString() });
    } catch (error) {
      this.running = false;
      ready.cancel();
      try { this.wsClient.close?.({ force: true }); } catch {}
      throw error;
    }
  }

  async stop() {
    this.running = false;
    this.wsDisconnects += 1;
    debugLog("feishu.ws.disconnected", { count: this.wsDisconnects, reason: "stop" });
    try {
      if (this.wsClient?.close) this.wsClient.close({ force: true });
      else await this.wsClient?.stop?.();
    } catch {}
    this.wsClient = undefined;
  }

  isRunning() {
    if (!this.running) return false;
    // SDK 自己的连接状态（重连中 / 已放弃）比回调标志更及时
    try {
      const st = (this.wsClient as any)?.getConnectionStatus?.()?.state;
      if (typeof st === "string" && st !== "connected") return false;
    } catch {}
    return this.running;
  }

  /** 长连接断线重连成功后回调（参数为断线开始时刻），用于补拉断线期间的消息。 */
  onReconnected(listener: (downSince: number | undefined) => void) {
    this.reconnectedListener = listener;
  }

  /**
   * 断线补拉：取会话里 sinceMs 之后的历史消息，走和实时事件完全相同的处理路径（上层按 message_id 持久化去重，
   * 已处理过的不会重复回复）。返回分发的条数。单聊需要 im:message（或 im:message:readonly），
   * 群聊还需要 im:message.group_msg，没有权限时抛 FeishuApiError（230027 / 99991672）。
   */
  async backfillChat(chatId: string, chatType: "p2p" | "group", sinceMs: number, maxPages = 3): Promise<number> {
    let pageToken: string | undefined;
    let dispatched = 0;
    for (let page = 0; page < maxPages; page++) {
      const res: any = await withFeishuRetry(() => this.sdkClient!.im.v1.message.list({
        params: {
          container_id_type: "chat",
          container_id: chatId,
          start_time: String(Math.floor(sinceMs / 1000)),
          sort_type: "ByCreateTimeAsc",
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }), "list messages");
      for (const item of res?.data?.items || []) {
        const event = historyItemToEvent(item, chatType);
        if (!event || Number(item.create_time) < sinceMs) continue;
        dispatched += 1;
        await this.processRawMessage(event);
      }
      if (!res?.data?.has_more || !res?.data?.page_token) break;
      pageToken = res.data.page_token;
    }
    return dispatched;
  }

  getBotOpenId() {
    return this.botOpenId;
  }

  private async probeBotOpenId() {
    try {
      const res: any = await this.sdkClient!.request({
        url: "/open-apis/bot/v3/info",
        method: "GET",
      });
      this.botOpenId = res?.bot?.open_id || res?.data?.bot?.open_id || res?.data?.open_id;
      if (!this.botOpenId) {
        throw new Error(`bot/v3/info response missing open_id: ${JSON.stringify(res).slice(0, 200)}`);
      }
    } catch (error) {
      throw new BotUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 飞书长连接要求事件在 3 秒内应答，否则会重推。原版在这里 await 了 chat.get（REST，最长 15 秒），
   * 慢的时候同一事件会被重推。现在立即返回，其余处理异步进行（重推由上层按 message_id 持久化去重）。
   */
  private handleRawMessage(data: any) {
    void this.processRawMessage(data).catch((error) => {
      debugLog("feishu.message.process_error", { error: error instanceof Error ? error.message : String(error) });
    });
    return undefined;
  }

  private async processRawMessage(data: any) {
    const event = data?.event || data;
    const message = event?.message;
    const sender = event?.sender;
    if (!message) return;
    const fromBot = sender?.sender_type === "bot" || sender?.sender_type === "app";
    if (fromBot) {
      const sid = sender?.sender_id || {};
      // 自己发的消息不处理（飞书本来也不推送，双保险）
      if ((this.botOpenId && sid.open_id === this.botOpenId) || (sid.app_id && sid.app_id === this.config.appId)) return;
      if (!this.config.acceptBotMessages) return;
      // 记下完整 sender_id，方便把对方填进 config.peerBots
      debugLog("feishu.message.from_bot", { messageId: message.message_id, senderId: sid, chatId: message.chat_id });
    }

    debugLog("feishu.message.received", {
      messageId: message.message_id,
      chatType: message.chat_type,
      messageType: message.message_type,
      hasRootId: Boolean(message.root_id),
      hasParentId: Boolean(message.parent_id),
      hasThreadId: Boolean(message.thread_id),
      contentLength: typeof message.content === "string" ? message.content.length : 0,
    });

    if (message.chat_type !== "p2p" && (this.config.groupPolicy || "mention") === "mention") {
      if (!this.isMentioned(message)) {
        debugLog("feishu.message.ignored_not_mentioned", { messageId: message.message_id });
        return;
      }
    }

    const chatMode = await this.getChatMode(message.chat_id, message.chat_type);
    const msg: FeishuMessage = {
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type,
      chatMode,
      senderOpenId: sender?.sender_id?.open_id || "unknown",
      ...(fromBot ? { senderType: "bot" as const, ...(typeof sender?.sender_id?.app_id === "string" ? { senderAppId: sender.sender_id.app_id } : {}) } : {}),
      msgType: message.message_type,
      content: message.content || "",
      rootId: message.root_id,
      parentId: message.parent_id,
      threadId: message.thread_id,
      mentions: message.mentions,
      createTime: message.create_time,
    };

    if (this.config.reactEmoji) {
      void this.addReaction(msg.messageId, this.config.reactEmoji);
    }
    debugLog("feishu.message.dispatch", { messageId: msg.messageId });
    void this.onMessage(msg).catch((error) => {
      debugLog("feishu.message.dispatch_error", {
        messageId: msg.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleCardAction(data: any) {
    // After EventDispatcher/RequestHandle.parse() the event fields are
    // flattened to the top level. data.event is gone; use data directly.
    const messageId = data?.context?.open_message_id || data?.open_message_id;
    const chatId = data?.context?.open_chat_id || data?.open_chat_id;
    const operatorOpenId = data?.operator?.open_id;
    if (!messageId || !operatorOpenId) return;
    debugLog("feishu.card.action", {
      messageId,
      chatId,
      hasToken: Boolean(data?.token),
      value: data?.action?.value,
      formValue: data?.action?.form_value,
    });
    const result = await this.onCardAction({
      messageId,
      chatId,
      operatorOpenId,
      eventId: typeof data?.event_id === "string" ? data.event_id : typeof data?.header?.event_id === "string" ? data.header.event_id : undefined,
      token: typeof data?.token === "string" ? data.token : undefined,
      value: data?.action?.value,
      formValue: data?.action?.form_value,
    });
    // The WSClient sends the return value back to the Feishu platform as
    // the card callback response. It must use the wrapped format:
    //   { "card": { "type": "raw", "data": { ... card JSON ... } } }
    if (result) {
      return { card: { type: "raw", data: result } };
    }
    return result;
  }

  private isMentioned(message: any): boolean {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (!mentions.length) return false;
    const botOpenId = this.botOpenId;
    if (!botOpenId) return true;
    return mentions.some((m: any) => m?.id?.open_id === botOpenId || m?.id?.union_id === botOpenId);
  }

  private async getChatMode(chatId: string, chatType: "p2p" | "group"): Promise<"p2p" | "group" | "topic"> {
    if (chatType === "p2p") return "p2p";
    const cached = this.chatModeCache.get(chatId);
    if (cached) return cached;
    try {
      const res = await this.sdkClient!.im.v1.chat.get({ path: { chat_id: chatId } });
      const mode = res?.data?.chat_mode === "topic" ? "topic" : "group";
      this.chatModeCache.set(chatId, mode);
      debugLog("feishu.chat.mode", { chatId, mode });
      return mode;
    } catch (error) {
      debugLog("feishu.chat.mode_error", {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "group";
    }
  }

  private async addReaction(messageId: string, emojiType: string) {
    try {
      await this.sdkClient!.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
    } catch {}
  }

  /**
   * 回复一段文本（调用方保证一段 = 一条飞书消息，见 textsplit.ts）。
   * opts.uuid：飞书 reply 接口的幂等键（1 小时内同一 uuid 只发一次）——重试 / 崩溃恢复重发都不会出现重复消息。
   * opts.atOpenId：把文中的 "@主人" 换成对应格式的 @：
   *   text 消息 <at user_id="ou_x">主人</at>；卡片 markdown <at id=ou_x></at>；
   *   post 富文本的 text 元素不解析 <at>（原版会把标签原样显示出来），所以含 @主人 时 post 降级为 text。
   */
  async replyText(messageId: string, text: string, opts: { uuid?: string; atOpenId?: string; ats?: AtTarget[]; forceText?: boolean } = {}) {
    let mode = opts.forceText ? "text" : chooseMessageMode(text);
    const targets: AtTarget[] = [...(opts.ats || []), ...(opts.atOpenId ? [{ id: opts.atOpenId, name: "主人" }] : [])];
    const hasAt = targets.some((t) => t.prefix || (t.name && text.includes("@" + t.name)));
    if (hasAt && mode === "post") mode = "text";
    if (hasAt) text = applyAts(text, targets, mode === "interactive" ? "card" : "text");
    if (mode === "interactive") {
      await this.replyMarkdownCard(messageId, text, opts.uuid);
      return;
    }
    if (mode === "post") {
      await this.replyPost(messageId, text, opts.uuid);
      return;
    }
    debugLog("feishu.reply.text", { messageId, length: text.length });
    const chunks = splitText(text, TEXT_CHUNK_MAX_BYTES);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      await withFeishuRetry(() => this.sdkClient!.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "text", content: JSON.stringify({ text: chunk }), ...uuidField(opts.uuid, i) },
      }), "reply text");
    }
  }

  async replyMarkdownCard(messageId: string, text: string, uuid?: string) {
    debugLog("feishu.reply.markdown_card", { messageId, length: text.length });
    const parts = buildMarkdownCardParts(text, this.config.language);
    for (let i = 0; i < parts.length; i++) {
      const { card } = parts[i];
      await withFeishuRetry(() => this.sdkClient!.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "interactive", content: JSON.stringify(card), ...uuidField(uuid, i) },
      }), "reply card");
    }
  }

  async replyPost(messageId: string, text: string, uuid?: string) {
    debugLog("feishu.reply.post", { messageId, length: text.length });
    const posts = buildPostMessages(text, this.config.language);
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      await withFeishuRetry(() => this.sdkClient!.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "post", content: JSON.stringify(post), ...uuidField(uuid, i) },
      }), "reply post");
    }
  }

  async replyCard(messageId: string, card: object, uuid?: string) {
    debugLog("feishu.reply.card", { messageId });
    const res: any = await withFeishuRetry(() => this.sdkClient!.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card), ...uuidField(uuid, 0) },
    }), "reply task card");
    return res?.data?.message_id as string | undefined;
  }

  // ---------------------------------------------------------------- CardKit（卡片实体，流式打字机）
  // 需要权限 cardkit:card:write。没有该权限时调用方回退到普通卡片 + PATCH。

  /** 创建卡片实体，返回 card_id。 */
  async createCardEntity(card: object): Promise<string> {
    debugLog("feishu.cardkit.create", {});
    const res: any = await withFeishuRetry(() => this.sdkClient!.cardkit.v1.card.create({
      data: { type: "card_json", data: JSON.stringify(card) },
    }), "create card entity");
    const id = res?.data?.card_id;
    if (typeof id !== "string" || !id) throw new Error("cardkit.card.create 没有返回 card_id");
    return id;
  }

  /** 以回复的形式发出一张卡片实体，返回 message_id。 */
  async replyCardEntity(messageId: string, cardId: string, uuid?: string) {
    debugLog("feishu.reply.card_entity", { messageId, cardId });
    const res: any = await withFeishuRetry(() => this.sdkClient!.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }), ...uuidField(uuid, 0) },
    }), "reply card entity");
    return res?.data?.message_id as string | undefined;
  }

  /** 全量更新卡片实体（sequence 每张卡严格递增）。 */
  async updateCardEntity(cardId: string, card: object, sequence: number) {
    debugLog("feishu.cardkit.update", { cardId, sequence });
    await withFeishuRetry(() => this.sdkClient!.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: { card: { type: "card_json", data: JSON.stringify(card) }, sequence, uuid: `u_${cardId}_${sequence}` },
    } as any), "update card entity");
  }

  /** 流式更新卡片里一个 markdown 组件的全文：新文本以旧文本开头时，新增部分以打字机效果输出。 */
  async streamCardText(cardId: string, elementId: string, content: string, sequence: number) {
    await withFeishuRetry(() => this.sdkClient!.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, sequence, uuid: `c_${cardId}_${sequence}` },
    }), "stream card text");
  }

  /** 打开 / 关闭卡片实体的流式模式。 */
  async setCardStreaming(cardId: string, on: boolean, sequence: number) {
    const config: Record<string, unknown> = { streaming_mode: on };
    // delay：上一段还没打完时新内容排队接着打（fast 会把没打完的部分直接闪现，长段落看起来就是"一口气出现"）
    if (on) config.streaming_config = { print_frequency_ms: { default: 30 }, print_step: { default: 2 }, print_strategy: "delay" };
    await withFeishuRetry(() => this.sdkClient!.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: { settings: JSON.stringify({ config }), sequence, uuid: `s_${cardId}_${sequence}` },
    }), "card streaming settings");
  }

  async updateCard(messageId: string, card: object) {
    debugLog("feishu.update.card", { messageId });
    await withFeishuRetry(() => this.sdkClient!.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }), "update card");
  }

  /**
   * 发送本机文件（路径须已由 files.ts 校验）。图片（魔数识别，≤10MB）走 image 消息；
   * 只有 .mp4 走 media（飞书 media 消息只接受 mp4），.mov/.avi 等按普通文件发；其余按文件。
   * 原版：先把整个文件读进内存再判断视频，视频分支又读一遍；.mov/.avi 也按 mp4 上传。
   */
  async replyLocalFile(messageId: string, filePath: string, uuid?: string) {
    const client = this.sdkClient;
    if (!client) throw new Error("Feishu transport is not running");

    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error("Only regular files can be sent");
    if (stat.size <= 0) throw new Error("Cannot send an empty file");
    if (stat.size > MAX_FILE_UPLOAD_BYTES) throw new Error("文件超过飞书机器人单文件 30 MB 上传限制。");

    const fileName = basename(filePath);
    const bytes = readFileSync(filePath);
    const isMp4 = /\.mp4$/i.test(fileName);
    const imageMime = isMp4 ? undefined : detectImageMime(bytes);
    if (imageMime && bytes.length <= MAX_IMAGE_UPLOAD_BYTES) {
      const uploaded: any = await withFeishuRetry(() => client.im.v1.image.create({
        data: { image_type: "message", image: bytes },
      }), "upload image");
      const imageKey = uploaded?.image_key || uploaded?.data?.image_key;
      if (!imageKey) throw new Error("Feishu image upload did not return image_key");
      await withFeishuRetry(() => client.im.message.reply({
        path: { message_id: messageId },
        data: { msg_type: "image", content: JSON.stringify({ image_key: imageKey }), ...uuidField(uuid, 0) },
      }), "reply image");
      debugLog("feishu.reply.local_image", { messageId, fileName, bytes: bytes.length });
      return { kind: "image" as const, fileName };
    }

    const uploaded: any = await withFeishuRetry(() => client.im.v1.file.create({
      data: { file_type: isMp4 ? "mp4" : feishuFileType(fileName), file_name: fileName, file: bytes },
    }), isMp4 ? "upload video" : "upload file");
    const fileKey = uploaded?.file_key || uploaded?.data?.file_key;
    if (!fileKey) throw new Error("Feishu file upload did not return file_key");
    await withFeishuRetry(() => client.im.message.reply({
      path: { message_id: messageId },
      data: isMp4
        ? { msg_type: "media", content: JSON.stringify({ file_key: fileKey }), ...uuidField(uuid, 0) }
        : { msg_type: "file", content: JSON.stringify({ file_key: fileKey }), ...uuidField(uuid, 0) },
    }), isMp4 ? "reply video" : "reply file");
    debugLog(isMp4 ? "feishu.reply.local_video" : "feishu.reply.local_file", { messageId, fileName, bytes: bytes.length });
    return { kind: isMp4 ? ("video" as const) : ("file" as const), fileName };
  }

  /** 下载用户消息里的图片/文件；maxBytes 超限即中止（原版无上限，整个读进内存）。 */
  async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file", maxBytes = 20 * 1024 * 1024): Promise<{ bytes: Buffer; mimeType?: string }> {
    debugLog("feishu.download.resource.start", { messageId, fileKey, type });
    const result: any = await this.sdkClient!.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    });
    const bytes = await streamToBuffer(readableFromDownload(result), maxBytes);
    const rawContentType = result.headers?.["content-type"] || result.headers?.["Content-Type"];
    const mimeType = typeof rawContentType === "string" ? rawContentType.split(";")[0]?.trim() : undefined;
    debugLog("feishu.download.resource.done", { messageId, fileKey, type, bytes: bytes.length, mimeType });
    return { bytes, mimeType: mimeType || undefined };
  }

}

/** 飞书 reply 的 uuid 字段（≤50 字符）；一次调用拆成多条时按序号派生。 */
/** 把"获取会话历史消息"接口的一条记录转成 im.message.receive_v1 事件的形状；撤回 / 删除的返回 undefined。 */
export function historyItemToEvent(item: any, chatType: "p2p" | "group") {
  if (!item?.message_id || !item?.chat_id || item.deleted) return undefined;
  const sender = item.sender || {};
  return {
    sender: {
      sender_type: sender.sender_type,
      sender_id: sender.id_type === "app_id" ? { app_id: sender.id } : { open_id: sender.id },
    },
    message: {
      message_id: item.message_id,
      chat_id: item.chat_id,
      chat_type: chatType,
      message_type: item.msg_type,
      content: item.body?.content || "",
      root_id: item.root_id,
      parent_id: item.parent_id,
      thread_id: item.thread_id,
      create_time: item.create_time,
      mentions: Array.isArray(item.mentions)
        ? item.mentions.map((m: any) => ({ key: m.key, name: m.name, id: { open_id: m.id } }))
        : undefined,
    },
  };
}

function uuidField(uuid: string | undefined, index: number): { uuid?: string } {
  if (!uuid) return {};
  return { uuid: (index ? `${uuid}-${index}` : uuid).slice(0, 50) };
}

export function configureSdkRestTimeout(client: Client, timeoutMs = REST_TIMEOUT_MS) {
  const http = (client as RuntimeSdkClient).httpInstance;
  if (http?.defaults) http.defaults.timeout = timeoutMs;
}

function feishuFileType(fileName: string) {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc" || ext === ".docx") return "doc";
  if (ext === ".xls" || ext === ".xlsx" || ext === ".csv") return "xls";
  if (ext === ".ppt" || ext === ".pptx") return "ppt";
  return "stream";
}

export function createWsReadyGate(timeoutMs: number) {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectPromise(new Error(`Feishu WebSocket did not connect within ${Math.ceil(timeoutMs / 1000)} seconds`));
  }, timeoutMs);
  timer.unref?.();
  const finish = (action: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    action();
  };
  return {
    promise,
    resolve: () => finish(resolvePromise),
    reject: (error: Error) => finish(() => rejectPromise(error)),
    cancel: () => finish(() => undefined),
  };
}

function splitText(text: string, maxBytes: number) {
  const out: string[] = [];
  let rest = text.trim() || "(empty response)";
  while (textPayloadSize(rest) > maxBytes) {
    const cut = findCutIndexByBytes(rest, maxBytes);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

function findCutIndexByBytes(text: string, maxBytes: number) {
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const safeMid = avoidHalfSurrogate(text, mid);
    if (safeMid > 0 && textPayloadSize(text.slice(0, safeMid)) <= maxBytes) {
      best = safeMid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const newline = text.lastIndexOf("\n", best);
  if (newline > 0 && newline >= Math.floor(best * 0.6)) return newline + 1;
  return Math.max(1, best);
}

function avoidHalfSurrogate(text: string, index: number) {
  if (index <= 0 || index >= text.length) return index;
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
  return index;
}

function byteSize(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function textPayloadSize(text: string) {
  return byteSize(JSON.stringify({ text }));
}

async function streamToBuffer(readable: NodeJS.ReadableStream, maxBytes = Infinity): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of readable as AsyncIterable<Buffer | string>) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > maxBytes) {
      (readable as any).destroy?.();
      throw new Error(`下载内容超过 ${Math.round(maxBytes / 1048576)}MB 上限`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function readableFromDownload(result: any): NodeJS.ReadableStream {
  return typeof result?.getReadableStream === "function" ? result.getReadableStream() : result;
}
