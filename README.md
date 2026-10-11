# muse-feishu-bridge 0.3.12

飞书 × Muse 桥接：在飞书里直接跟 Muse 聊天。企业自建应用 + WebSocket 长连接，不需要公网回调地址。

## 架构

```
飞书消息（WebSocket 长连接）
  → bridge.ts（message_id 持久化去重 / 白名单 / 解析文本 / 下载图片文件 / 记回复路由）
  → inbox/<id>.json
  → Muse 助手（hook 轮询认领并唤醒）
  → outbox/<id>.json
  → outbox.ts 投递（唯一发送路径：认领 → 分段 → uuid 幂等 → 进度落盘）→ 回到飞书
```

## 快速开始

1. 在[飞书开放平台](https://open.feishu.cn/)创建企业自建应用，开启机器人能力
2. 事件订阅选择"使用长连接接收事件"，订阅 `im.message.receive_v1`；回调配置也选长连接，订阅 `card.action.trigger`（/stop、恢复会话等卡片按钮要用，不订阅点按钮会报 200672）
3. 开通权限（"权限管理 → 批量导入"粘贴下面的 JSON 一次开齐）：
   - `im:message`、`im:message.p2p_msg:readonly`：收单聊消息、发消息
   - `im:message:send_as_bot`：以机器人身份回复
   - `im:message.group_at_msg:readonly`：收群里 @ 机器人的消息
   - `im:message.group_at_msg.include_bot:readonly`：收其他机器人 @ 你的消息（多机器人接力）
   - `im:message:update`：卡片原地更新（处理中 → 已完成）
   - `im:message.reactions:write_only`：收到消息先回表情
   - `im:resource`：上传/下载图片和文件
   - `im:chat:readonly`：读取群信息
4. 发布应用版本，拿到 App ID / App Secret（以后补开权限也要重新发布版本才生效）

```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
      "im:message.group_at_msg:readonly",
      "im:message.group_at_msg.include_bot:readonly",
      "im:message:update",
      "im:message.reactions:write_only",
      "im:resource",
      "im:chat:readonly"
    ],
    "user": []
  }
}
```

```bash
npm install
cp secrets.env.example secrets.env && chmod 600 secrets.env   # 填 FEISHU_APP_ID / FEISHU_APP_SECRET
cp config.example.json config.json                             # 填 allowedOpenIds
npm run build
npm run check-config
npm test                                                       # 29 项，离线（假 SDK），不连飞书
node dist/daemon.js
```

## 配置（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowedOpenIds` | 必填 | 允许使用的飞书 open_id（`ou_` 开头）。为空拒绝启动 |
| `ownerOpenId` | allowedOpenIds[0] | 回复里的 `@主人` 会变成对他的 @ 提醒 |
| `replyTimeoutMin` | 20 | 超时分钟数（见下"超时"） |
| `groupPolicy` | `mention` | 群里只有 @ 机器人才处理；`open` = 白名单成员的群消息都处理 |
| `proxy` | `auto` | `auto` 读 HTTPS_PROXY / NO_PROXY；`off` 强制直连；或填 `http://host:port` |
| `dedupSameTextSeconds` | `0`（关） | 同发送者同文本 N 秒内只处理一次。飞书重推用同一 message_id，已默认去重；只有日志里确实看到不同 message_id 的同一条消息才打开 |
| `ackDelaySec` | 8 | 多少秒没回复先发"处理中"状态卡（classic 下是文字"收到，正在处理"）；0 关闭 |
| `peerBots` | 无 | 协作机器人 `[{name, appId, openId}]`，见"机器人 @ 机器人" |
| `botMaxPerMinute` | 6 | 每会话每分钟最多接收几条机器人消息 |
| `botMaxHops` | 3 | 机器人之间最多接力几手 |
| `replyStyle` | `"card"` | `card`：所有回复都是状态卡片；`classic`：旧版（短回复纯文本、长回复才用卡片） |
| `allowedFileRoots` | `<ROOT>/outgoing`、`/tmp` | 允许外发的本机文件目录 |
| `maxDownloadMB` | 20 | 下载用户图片/文件的上限 |
| `domain` | `feishu` | 国际版填 `lark` |

## inbox / outbox 格式

inbox（daemon 写，助手读）：

```json
{
  "messageId": "om_xxx", "replyTo": "om_xxx", "chatId": "oc_xxx", "chatType": "p2p",
  "senderOpenId": "ou_xxx", "msgType": "text", "text": "正文（群聊 @机器人 已去掉）",
  "attachments": [{ "kind": "image", "path": "/…/incoming/om_xxx/1-image-1.png" }],
  "filePath": "/…/第一个附件（兼容旧字段）", "ts": "…", "status": "new",
  "mentions": [{ "openId": "ou_zhang", "name": "张三" }],
  "fromBot": true, "senderName": "小B", "hop": 1
}
```

`mentions`：消息里被 @ 的人/机器人（不含本机器人）。`fromBot`/`senderName`/`hop` 只在协作机器人发来的消息里出现。

卡片点击的 `messageId` 是 `card_<哈希>`，`replyTo` 是被点的那张卡片；助手照常写 `outbox/card_<哈希>.json` 即可。

outbox（助手写，**请先写临时文件再 rename**）：

```json
{ "messageId": "om_xxx", "text": "回复正文（支持 @主人）", "file": "/…/outgoing/报告.pdf", "card": { }, "ats": ["张三", "ou_xxx"] }
```

- `ats`：要真正 @ 的对象（名字或 open_id）。只允许本条消息里被 @ 的、发送者、主人、`peerBots`；其他丢弃并记日志

- 长文本自动分段（每段 ≤3000 字符、代码块不会被切坏）
- `file`：图片发图片消息；`.mp4` 发视频；其余按文件。必须在 `allowedFileRoots` 内，敏感文件（secrets.env、config.json、私钥、硬链接…）一律拒绝并告知用户

## 投递保证

- 同一条回复只发一次：进程内同 id 互斥 + 文件认领（outbox → inflight 原子 rename）+ 单实例锁
- 每段带飞书 `uuid` 幂等键：重试、崩溃恢复都不会出现重复消息
- 部分成功只补发失败部分；永久错误（4xx / 业务错误码）进 `failed/`，并写 `failed/<id>.reason.json`
- 临时错误 1 小时内同一段失败 5 次进 `failed/`
- 崩溃后重启：`inflight/` 里的回复按进度续发

## 超时

- 消息在 inbox 里一直没被认领（助手没接）→ 超时后移到 `expired/`，告诉用户"请重发"，之后迟到的回复不再发出
- 已被认领但超时还没回复 → 只提醒一次"还在处理"，回复到了照常发
- 超时巡检基于 inbox 文件时间戳，daemon 重启后依然生效

## 保活

```bash
bash keepalive.sh            # 健康则静默退出；进程不在 / 心跳停滞 / 长时间断线则拉起
bash keepalive.sh --status   # 只检查
bash keepalive.sh --install-cron    # 一键装 cron：每 5 分钟检查 + 开机 30 秒后拉起（可重复执行）
bash keepalive.sh --uninstall-cron
```

keepalive 用 pid + 进程启动时间 + 启动令牌核实身份，只会杀自己拉起的 daemon；自身有 flock（无 flock 时 mkdir 锁）防并发。daemon 自己也持有 `daemon.lock`，手动重复启动会被拒绝。

## 排障

1. **收不到消息**：事件订阅是否为长连接模式、是否订阅 `im.message.receive_v1`、应用版本是否已发布
2. **发不出消息**：看 `failed/<id>.reason.json` 里的飞书 code（如 230002 机器人不在群里、99991672 缺权限）
3. **收不到图片内容**：开通 `im:resource` 权限
4. **启动失败"已有 daemon 持有锁"**：已有实例在跑（`bash keepalive.sh --status`）

## 代理环境

飞书 SDK 的 REST 请求走 axios，会读取 `HTTPS_PROXY` 环境变量；但长连接用的 `ws` 库**不读**代理变量。
0.2.0 起：检测到 `HTTPS_PROXY`（或 `HTTP_PROXY` / `ALL_PROXY`）时，REST 和长连接统一走同一个 CONNECT 隧道；遵守 `NO_PROXY`。
`config.json` 里 `"proxy": "off"` 强制直连，填 `"http://host:port"` 则覆盖环境变量。`--check-config` 会显示实际出网方式。

## 卡片样式（replyStyle: card，默认）

每条回复是一张飞书卡片（JSON 2.0）：彩色状态标题 + Markdown 正文 + 灰色小字页脚。

| 状态 | 标题 | 颜色 |
|---|---|---|
| 超过 `ackDelaySec` 还没回复 | ⏳ 处理中 | 蓝 |
| 超过 `replyTimeoutMin` 仍在处理（已认领） | ⏳ 仍在处理 | 橙 |
| 回复到达 | ✅ 已完成（页脚：耗时 · 时间） | 绿 |
| 超时未认领 / 发送失败 | ⚠️ 已超时 / ❌ 出错了 | 红 |
| 斜杠命令 | 📊 桥接状态 等 | 靛蓝 |

- "处理中"卡**原地更新**为最终答案（PATCH 消息），不再多出一条"收到，正在处理"。卡片 message_id 存在 `routes.json`，daemon 重启后照样更新。
- 长回复分段时：第 1 段更新状态卡，后面每段新发一张，标题带 `（2/3）`，页脚只在最后一段。
- 更新卡片被飞书拒绝（如应用缺少"更新应用发送的消息" `im:message:update` 权限、卡片过期）→ 自动退回新发一张，不丢消息；临时错误按部件重试，不会重复。
- 回复只有文件时，文件发出后状态卡自动变为"已完成"。
- 想回到旧样式：config.json 里加 `"replyStyle": "classic"`。

## 机器人 @ 机器人（接力）

两个都跑本桥接的机器人 A、B 在同一个群里，可以互相 @ 交活。

**配置（两边都要做）**
1. 飞书开放平台 → 应用 → 权限管理，开通"获取群组中其他机器人和用户@当前机器人的消息"（`im:message.group_at_msg.include_bot:readonly`），发布新版本
2. 在群里发 `@A /ids @B`，A 会回 B 在 A 应用里的 open_id（open_id 按应用区分，A 看到的 B 和 B 自己看到的不一样）
3. A 的 config.json：
   ```json
   "peerBots": [{ "name": "B", "appId": "cli_B的AppID", "openId": "上一步查到的 ou_…" }]
   ```
   B 那边同理登记 A。改完重启 daemon。

**规则**
- 只接收登记过的机器人、且明确 @ 了本机器人的消息；没 @ 的（比如 B 做完后的普通回复）不处理
- 同一会话每分钟最多接收 `botMaxPerMinute`（默认 6）条机器人消息
- 回复里 @ 协作机器人时：整段作为一条**纯文本**发（不用卡片，保证对方收到），文末带 `〔接力 n/3〕`；每转一手 +1，到 `botMaxHops`（默认 3）后不再 @ 机器人
- 机器人发来的斜杠命令不执行

## 消息处理 hook 与多轮上下文（0.3.12）

`hooks/` 里是 Muse 侧的轮询脚本和 hook 定义模板，部署步骤见 SKILL.md。

Muse 的 hook 每次 wake 都是全新 worker，看不到上次聊了什么。轮询脚本自己维护上下文，桥接代码不用改：

- 回复真正发出去（归档到 `sent/`）后，把"用户原文 / 回复"记一轮；发送失败、超时作废、一天没回的不记
- 唤醒时把本会话的摘要 + 历史轮写进上下文文件，payload 里带路径
- 每个会话上限 512KB（UTF-8，约 17 万汉字），超了由 worker 把旧的几轮压成摘要交给脚本合并，历史文件始终只有脚本在写，不会互相覆盖
- 发 `/clear` 开始新话题，旧的归档保留 30 天；普通历史 7 天没动自动删
- 发 `/compact`（可带重点，如 `/compact 保留部署步骤`）手动压缩上下文：较早的对话压成摘要、保留最近 2 轮原文，进行中的任务不受影响；超过 512KB 时也会自动压缩
- 私聊和每个群分开；群里的话题和群主聊天共用一份，多人说话不区分是谁

## 斜杠命令

白名单用户发送以下命令时，daemon 直接回复，不进 inbox，也不唤醒助手：

- `/help`：列出可用命令
- `/ping`：测试连通性
- `/status`：长连接状态、运行时长、inbox/outbox/发送中/失败数量
- `/stop`（群里 `@机器人 /stop` 也行）：发现指令发错了，立刻中断本会话里所有还没回完的任务，然后直接发新指令即可（不需要 /start）
  - daemon 收到就处理，不等 hook 轮询：把这些消息的 inbox 文件（未认领或已认领）移到 `expired/` 并留 `<id>.stopped`，写墓碑，写 `stop/<会话>.json`
  - 被中断任务的回复（之后才写出的、正在分段发送的）一律不再发出；"处理中"卡改成灰色"已停止"
  - worker 每步动手前检查自己的 `.claimed` 还在不在，不在就停下；已经执行完的步骤撤不回来
  - 历史里记成"被中断"的一轮；之后第一条新消息带 `after_stop`，worker 按新指令做、不接着做旧任务
  - 范围是整个会话（私聊或这个群），群里任何白名单成员都能中断
- 桥接健康检查：hook 在没有新消息时顺便看 `heartbeat.json`，超过 10 分钟没更新（daemon 挂了/卡死/一直连不上，keepalive 也没救回来）就唤醒 worker（payload 带 `health_issue`），worker 先跑 keepalive 拉起、看日志修复，再报告结果；同一个故障每小时最多提醒一次，恢复后自动复位

只拦截已登记的命令。像 `/tmp/a.log 帮我看下` 这类未登记的内容照常交给助手。新增命令请在 `src/slash.ts` 的 `COMMANDS` 里加一项。
