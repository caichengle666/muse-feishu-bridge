# muse-feishu-bridge

飞书 × Muse 桥接：在飞书里直接跟 Muse AI 聊天（企业自建应用 + WebSocket 长连接，无需公网回调）。

## 消息流

- **收**：飞书 WS → daemon（message_id 持久化去重 / 白名单 / 下载图片文件）→ `inbox/<messageId>.json`
- **处理**：hook 轮询 inbox，原子认领后唤醒助手
- **发**：助手写 `outbox/<messageId>.json`（先写临时文件再 rename）→ daemon 每秒投递 → 归档 `sent/`

## outbox 格式

```json
{ "messageId": "om_xxx", "text": "回复正文（支持 @主人）", "file": "/绝对路径（须在 outgoing/ 或 /tmp）" }
```

- inbox 里的 `attachments[].path` 是用户发来的图片/文件的本地路径
- 卡片点击的 inbox id 是 `card_…`，照常用这个 id 写 outbox，daemon 会回复到被点的卡片
- 发送失败看 `failed/<id>.reason.json`

## @ 别人 / 机器人之间接力

- inbox 的 `mentions: [{openId, name}]` 是这条消息里被 @ 的人和机器人（不含自己）
- 要真正 @ 谁，在 outbox 加 `"ats": ["张三", "ou_xxx"]`（名字或 open_id）。正文里写 `@张三` 会就地变成 @，没写的在开头补
- 正文里直接写 `@协作机器人名字` 或 `@本条消息里被@的人` 也会自动识别成真 @（不想提醒对方就别带 @ 写名字）
- 只能 @：本条消息里被 @ 的、发送者、主人、`config.peerBots` 里登记的协作机器人；其他会被丢弃
- inbox 带 `fromBot: true` 表示是协作机器人交给你的活，`senderName` 是它的称呼，`hop` 是第几手
- 交活给别的机器人：`ats` 里写它的名字即可；到 `botMaxHops`（默认 3）手后不能再 @ 机器人，直接回复结果
- 机器人交来的活做完后，如果不需要对方继续，就**不要**再 @ 它（否则会来回接力）

## 注意事项

- `allowedOpenIds` 为空拒绝启动；只放自己的 open_id
- daemon 自带单实例锁；保活用 `keepalive.sh`（cron 每 5 分钟）
- secrets.env 用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，权限 600，不进 git
