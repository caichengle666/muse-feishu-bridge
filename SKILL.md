# muse-feishu-bridge

飞书企业自建应用 × Muse 双向桥接：在飞书里直接跟 Muse 对话，手机免代理也能用完整功能。

## 适用场景

- 想在飞书里直接跟 Muse 对话（文本、图片、文件、视频）
- 群聊里 @ 机器人提问，不 @ 时保持安静
- 需要 Muse 主动推送消息到飞书（如每日早报、告警）
- 需要卡片式回复（处理中 → 已完成的状态卡片）
- 一个群里多个机器人协作：@ 某个机器人让它干活，机器人之间可接力

## 运行要求

- Node.js 18+
- 飞书开放平台创建**企业自建应用**，开启机器人能力，事件订阅选"使用长连接接收事件"，订阅 `im.message.receive_v1`
- 开通权限（建议一次性全开，后面再加要重新发布应用版本）：`im:message`、`im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:resource`（下载用户发的图片/文件）、"更新应用发送的消息"（卡片原地更新）、`im:message.group_at_msg.include_bot:readonly`（备注：机器人互动——收其他机器人 @ 你的消息）、`im:chat`（获取与更新群组信息，免审）、`im:chat:read`（查看群信息，免审）、`im:chat:readonly`（获取群组信息，免审）、`im:chat.members:read`（查看群成员）
- `config.json` 的 `allowedOpenIds` 白名单 fail-closed（为空拒绝启动）

## 部署

```bash
git clone https://github.com/caichengle666/muse-feishu-bridge && cd muse-feishu-bridge
npm ci
cp secrets.env.example secrets.env  # 填入 FEISHU_APP_ID / FEISHU_APP_SECRET，chmod 600
cp config.example.json config.json  # 填 allowedOpenIds（飞书 open_id）
npm run build && npm test
node dist/daemon.js  # 或用 keepalive.sh + cron 常驻
```

## 不会申请机器人？让 Muse 代办

没操作过飞书开放平台不用自己研究——直接在 **Muse App 里开启浏览器操作模式**，跟 Muse 说：

> "帮我在飞书开放平台创建一个 Muse 机器人应用"

Muse 会在浏览器里帮你走完：

1. 创建企业自建应用并开启机器人能力
2. 事件订阅选"使用长连接接收事件"，订阅 `im.message.receive_v1`
3. 开通所需权限（一次性全开，后面再加要重新发布版本）：`im:message`、`im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:resource`、"更新应用发送的消息"（卡片原地更新）、`im:message.group_at_msg.include_bot:readonly`（备注：机器人互动——收其他机器人 @ 你的消息）、`im:chat`（获取与更新群组信息，免审）、`im:chat:read`（查看群信息，免审）、`im:chat:readonly`（获取群组信息，免审）、`im:chat.members:read`（查看群成员）
4. 发布应用版本
5. 取出 App ID 和 App Secret，帮你写好 `secrets.env`（密钥只存你本地，不会外传）

你只需要在登录、扫码验证这类环节接管一下浏览器。

白名单要填你自己的飞书 open_id：先随便填个占位把服务跑起来，然后你给机器人发任意一条消息，Muse 会从日志里拿到你真正的 open_id，帮你填好重启。

## 消息处理 hook（部署时必建）

inbox 里的消息不会自己处理——部署完 daemon 后必须创建一个轮询 hook（习惯名 `feishu-inbox-watch`）：

- 用 `hooks.add` 注册，`script_path` 指向 `~/hooks/scripts/feishu-inbox-watch.sh`
- **必须指定 `poll_interval_secs: 5`**（hook 允许的最小值；不指定默认 60 秒，用户发消息后要等一分钟才有回复）
- 轮询脚本逻辑：检查 `inbox/` 有无新的 `.json`，有则原子认领（rename 为 `.json.claimed`）后 `wake` 唤醒 worker
- worker 的 prompt 要写清：读取 claimed 文件 → 作答 → 写 `outbox/<id>.json` → 删除 claimed 文件（= 消费确认）
- 写 outbox 必须用标准 JSON 序列化，禁止手拼 JSON 字符串；正文里的双引号、换行、反斜杠必须正确转义，否则 daemon 解析失败发不出去
- claimed 文件 25 分钟没被消费会被重新认领重试

## 消息流（给实现 AI 后端看）

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

- 登记协作机器人（0.3.5+）：在群里发 `/ids @某机器人`，会收到一张带"登记为协作机器人"按钮的卡片，点一下就同时写进 `config.json` 的 `peerBots` 并同步到运行中的 daemon，**立即生效，不用重启**（按钮只有白名单里的人点了才算数）
- inbox 的 `mentions: [{openId, name}]` 是这条消息里被 @ 的人和机器人（不含自己）
- 要真正 @ 谁，在 outbox 加 `"ats": ["张三", "ou_xxx"]`（名字或 open_id）。正文里写 `@张三` 会就地变成 @，没写的在开头补
- 正文里直接写 `@协作机器人名字` 或 `@本条消息里被@的人` 也会自动识别成真 @（不想提醒对方就别带 @ 写名字）
- 只能 @：本条消息里被 @ 的、发送者、主人、`config.peerBots` 里登记的协作机器人；其他会被丢弃
- inbox 带 `fromBot: true` 表示是协作机器人交给你的活，`senderName` 是它的称呼，`hop` 是第几手
- 交活给别的机器人：`ats` 里写它的名字即可；到 `botMaxHops`（默认 3）手后不能再 @ 机器人，直接回复结果
- 机器人交来的活做完后，如果不需要对方继续，就**不要**再 @ 它（否则会来回接力）

## 外部影响

- 本机主动向外建 WebSocket 长连接收飞书事件，无需公网回调地址；出网可走 HTTP 代理（`proxy` 配置）
- 收到的图片/文件下载到本地 `incoming/`
- 同一飞书应用只应有一条长连接；daemon 自带单实例锁，多开会被拒绝

## 重要边界

- 消息处理逻辑（AI 后端）由部署者自己接 `inbox/`/`outbox/` 文件队列实现，本仓库只提供桥接层
- 群聊默认只响应 @（`groupPolicy: mention`），私聊全响应
- `secrets.env` 含应用密钥，绝不提交；外发文件白名单仅限 `outgoing/` 与 `/tmp`，拒绝 `*.env` 等敏感文件
- 卡片原地更新需要应用有"更新应用发送的消息"权限并发布新版本；没开也能用，只是会多出一张卡
- `allowedOpenIds` 为空拒绝启动；只放自己的 open_id
