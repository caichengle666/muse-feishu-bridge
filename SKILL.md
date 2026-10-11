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
- 飞书开放平台创建**企业自建应用**，开启机器人能力，事件订阅选"使用长连接接收事件"，订阅 `im.message.receive_v1`；回调配置同样选长连接，订阅 `card.action.trigger`（/ids 登记协作机器人等卡片按钮要用，不订阅点按钮会报 200672）
- 开通权限（建议一次性全开，后面再加要重新发布应用版本）：`im:message`、`im:message.p2p_msg:readonly`（收单聊消息）、`im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:resource`（上传/下载图片和文件）、`im:message:update`（更新应用发送的消息，卡片原地更新）、`im:message.reactions:write_only`（收到消息先回表情）、`im:message.group_at_msg.include_bot:readonly`（机器人互动——收其他机器人 @ 你的消息）、`im:chat:readonly`（获取群组信息，免审）、`cardkit:card:write`（流式打字机卡片）；可选：`im:chat`、`im:chat:read`、`im:chat.members:read`（当前代码未用到，留给以后的群管理功能）。完整清单可用下方 JSON 在"权限管理 → 批量导入"一次开通
- `config.json` 的 `allowedOpenIds` 白名单 fail-closed（为空拒绝启动）

权限批量导入 JSON（必需项；可选的 `im:chat`、`im:chat:read`、`im:chat.members:read` 需要时自己加）：

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
      "im:chat:readonly",
      "cardkit:card:write"
    ],
    "user": []
  }
}
```

开通或补开权限后，必须在"版本管理与发布"里发布新版本才生效。

## 部署前先问用户（必须等回答再往下走）

开始装之前，把下面几个选择**一条消息**发给用户，每项写明推荐项；用户回「默认」就全用推荐值。**用户没回答前不要执行任何安装命令**，选完把结果写进 `config.json` 再继续：

1. **机器人名称**：建好后扫码改不了。推荐「{用户名} 的 Muse」
2. **创建方式**：A 扫码新建应用（推荐，权限/事件/白名单全自动）；B 已有飞书应用，用户提供 App ID / Secret（缺权限再扫一次 `--update-permissions`）；C 浏览器代办，在开放平台手动建
3. **群聊怎么回**：A 只在 @ 机器人时回（推荐，`groupPolicy: "mention"`）；B 白名单成员在群里说话都回（`"open"`）
4. **群聊断线补拉**：A 不要，只补单聊（推荐）；B 要——得另开敏感权限 `im:message.group_msg`（获取群组中所有消息），企业管理员审核通过并发布新版本后才生效
5. **回复样式**：A 卡片 + 打字机流式（推荐，`replyStyle: "card"`）；B 纯文本消息，没有流式（`"classic"`）
6. **开机自启保活**：A 装 cron（推荐，`keepalive.sh --install-cron`）；B 不装，只靠 hook 兜底拉起

中途遇到上面没覆盖、但会影响用户的选择（例如要覆盖已有 `secrets.env`、要换掉已有应用），同样先问再做。

## 部署（推荐：扫码建应用）

```bash
git clone https://github.com/caichengle666/muse-feishu-bridge && cd muse-feishu-bridge
npm ci && npm run build && npm test
npm run onboard -- --name "<用户想要的机器人名称>"   # 后台运行，见下
npm run check-config
bash keepalive.sh --install-cron && bash keepalive.sh   # 常驻（第 6 项选 B 就去掉 --install-cron 那半句）
# 注册 hook（见下文「消息处理 hook」）后：
npm run doctor   # 只读自检，全部 OK 才算部署完成；FAIL 项按提示修
```

部署收尾：`npm run doctor` 没有 FAIL 后，请用户**关掉 Muse 网页、只用手机飞书**给机器人发一条消息，收到回复才算真的通了。

`npm run onboard` 的做法（Muse 照做）：

1. 用上面第 1 项用户定的名称作为 `--name` 传入
2. 后台运行 onboard（它会一直等扫码，最长 60 分钟），把输出写到日志；几秒后日志里会出现一条 `https://open.feishu.cn/page/launcher?...` 链接，同时生成 `onboard-qr.png`
3. **把 `onboard-qr.png` 图片发给用户**（同时附上链接，手机上可直接点开），请用户用**手机飞书**扫码，在飞书的确认页核对名称和权限后点确认
4. 用户确认后 onboard 自动退出并输出"成功"：App ID / Secret 已写入 `secrets.env`（600），扫码人的 open_id 已加入 `config.json` 白名单并设为主人，所需权限、长连接事件 `im.message.receive_v1`、卡片回调 `card.action.trigger` 都已开好，**不用进开发者后台、不用手动发布版本**
5. 已有应用缺权限（如想用打字机效果但缺 `cardkit:card:write`）：`npm run onboard -- --update-permissions`，同样发二维码给用户扫一次
6. 输出 access_denied = 用户点了拒绝；expired = 二维码过期，重新运行即可；扫码流程用不了就走下面的手动方式

## 手动部署（扫码不可用时）

```bash
cp secrets.env.example secrets.env  # 填入 FEISHU_APP_ID / FEISHU_APP_SECRET，chmod 600
cp config.example.json config.json  # 填 allowedOpenIds（飞书 open_id）
npm run build && npm test
node dist/daemon.js  # 或用 keepalive.sh + cron 常驻
```

## 不会申请机器人？让 Muse 代办（手动方式）

没操作过飞书开放平台不用自己研究——直接在 **Muse App 里开启浏览器操作模式**，跟 Muse 说：

> "帮我在飞书开放平台创建一个 Muse 机器人应用"

Muse 会在浏览器里帮你走完：

1. 创建企业自建应用并开启机器人能力
2. 事件订阅选"使用长连接接收事件"，订阅 `im.message.receive_v1`；回调配置选长连接，订阅 `card.action.trigger`（卡片按钮）
3. 开通所需权限（一次性全开，后面再加要重新发布版本）：`im:message`、`im:message.p2p_msg:readonly`（收单聊消息）、`im:message:send_as_bot`、`im:message.group_at_msg:readonly`、`im:resource`（上传/下载图片和文件）、`im:message:update`（更新应用发送的消息，卡片原地更新）、`im:message.reactions:write_only`（收到消息先回表情）、`im:message.group_at_msg.include_bot:readonly`（机器人互动——收其他机器人 @ 你的消息）、`im:chat:readonly`（获取群组信息，免审）、`cardkit:card:write`（流式打字机卡片）；可选：`im:chat`、`im:chat:read`、`im:chat.members:read`（当前代码未用到，留给以后的群管理功能）。完整清单可用下方 JSON 在"权限管理 → 批量导入"一次开通
4. 发布应用版本
5. 取出 App ID 和 App Secret，帮你写好 `secrets.env`（密钥只存你本地，不会外传）

你只需要在登录、扫码验证这类环节接管一下浏览器。

白名单要填你自己的飞书 open_id：先随便填个占位把服务跑起来，然后你给机器人发任意一条消息，Muse 会从日志里拿到你真正的 open_id，帮你填好重启。

## 消息处理 hook（部署时必建）

inbox 里的消息不会自己处理——部署完 daemon 后必须创建一个轮询 hook（习惯名 `feishu-inbox-watch`）。
本仓库 `hooks/` 目录已备好开箱即用的脚本和定义模板：

- `hooks/feishu-inbox-watch.sh` → 复制到 `~/hooks/scripts/feishu-inbox-watch.sh`
- `hooks/feishu-inbox-watch.json` → 用 `hooks.add` 注册，把 `delivery.to` 换成用户自己的 side chat ID
- **必须指定 `poll_interval_secs: 5`**（hook 允许的最小值；不指定默认 60 秒，用户发消息后要等一分钟才有回复）
- 轮询脚本逻辑：检查 `inbox/` 有无新的 `.json`，有则原子认领（rename 为 `.json.claimed`）后 `wake` 唤醒 worker
- worker 的 prompt 要写清：读取 claimed 文件 → 作答 → 写 `outbox/<id>.json` → 删除 claimed 文件（= 消费确认）
- 写 outbox 必须用标准 JSON 序列化，禁止手拼 JSON 字符串；正文里的双引号、换行、反斜杠必须正确转义，否则 daemon 解析失败发不出去
- claimed 文件 25 分钟没被消费会被重新认领重试

### 多轮上下文（hook 自带，无需改桥接代码）

每次 wake 都是全新的 worker，默认没有上文。轮询脚本自动维护每个会话（chatId）的历史，**历史文件只由脚本写**：

- 认领时记下用户原文（附件记文件名）→ 回复归档到 `sent/` 后 → 追加一轮到 `~/hooks/state/feishu-ctx-<key>.json`
- 唤醒时按 messageId 写进上下文文件 `~/hooks/state/feishu-wake-*.json`：`{messageId: {ctx_key, summary, turns, compress_needed}}`，payload 只带 `context_file` 路径（上下文可能很大，不塞进 wake 参数）；同一会话里还没回完的前几条也会带上；文件一天后自动删
- 只按大小限制（512KB，UTF-8 字节，含摘要），不按轮数。超限时给最新那条标 `compress_needed`，worker 回复完后把最旧的几轮压缩成摘要，写 `feishu-ctx-<ctx_key>.summary.json`：`{summary, upto_seq}`，脚本下一轮合并（删掉 seq ≤ upto_seq 的轮）
- worker 一直没压缩、涨到 2 倍上限时，脚本兜底从最旧的开始丢
- `/clear`（群里 `@机器人 /clear` 也行）：脚本认领时直接把历史归档（保留 30 天），这条和同会话更早没回完的都不进新历史；用户用自然语言说换话题时，worker 写 `feishu-ctx-<ctx_key>.clear.json`：`{messageId}`，效果相同
- `/compact [重点]`（群里 `@机器人 /compact` 也行）：手动压缩，这条本身不进历史；上下文带 `compact: true`、`compact_hint`、`size_bytes`，并强制 `compress_needed: true`，worker 把 summary 和除最近 2 轮外的带 seq 的轮压成摘要，照常写 `feishu-ctx-<ctx_key>.summary.json`；还在处理中的任务（没 seq 的）不动，回复后照常入历史
- `/stop`（`@机器人 /stop` 也行）：daemon 直接处理，中断本会话所有没回完的消息——inbox 文件移到 `expired/` 并留 `<id>.stopped`、写墓碑（迟到的回复不发）、写 `stop/<会话>.json`；worker 每步动手前检查自己的 `.claimed` 是否还在，不在就停；脚本收割时把被中断的那条记成"被中断"一轮，之后第一条新消息的上下文带 `after_stop: true`
- 普通历史 7 天没动自动删；state 全部原子写入；轮询脚本加了 flock，同一时刻只跑一个
- 私聊、每个群各自一份；群里的话题和群主聊天共用一份，群里多人说话时不区分是谁

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

## 流式输出（打字机效果）

长回复可以边写边让用户看到：处理过程中往 `stream/<messageId>.jsonl` 追加，每行一个 JSON：`{"text":"这一段内容\n\n"}`。

- 各行的 text 按原样首尾相接（不加分隔符，换行自己写进 text），用标准 JSON 序列化，一次追加一整行
- daemon 每秒把累计内容推到这条消息的状态卡：有 `cardkit:card:write` 权限时是飞书原生打字机效果，没有时逐段刷新
- **最后仍然必须写 `outbox/<id>.json`（完整正文）**，它到达后卡片变成最终回复、stream 文件自动删除；只写 stream 不写 outbox，用户收不到最终结果
- 卡片上流式部分最多显示约 3000 字，更长的内容在 outbox 到达后分段完整发出
- 只在卡片模式（默认）生效；`config.json` 设 `"streamReplies": false` 可关闭

## @ 别人 / 机器人之间接力

- 登记协作机器人：在群里发 `/ids @某机器人`，会收到一张带"登记为协作机器人"按钮的卡片，点一下就同时写进 `config.json` 的 `peerBots` 并同步到运行中的 daemon，**立即生效，不用重启**（按钮只有白名单里的人点了才算数）
- inbox 的 `mentions: [{openId, name}]` 是这条消息里被 @ 的人和机器人（不含自己）
- 要真正 @ 谁，在 outbox 加 `"ats": ["张三", "ou_xxx"]`（名字或 open_id）。正文里写 `@张三` 会就地变成 @，没写的在开头补
- 正文里直接写 `@协作机器人名字` 或 `@本条消息里被@的人` 也会自动识别成真 @（不想提醒对方就别带 @ 写名字）
- 只能 @：本条消息里被 @ 的、发送者、主人、`config.peerBots` 里登记的协作机器人；其他会被丢弃
- inbox 带 `fromBot: true` 表示是协作机器人交给你的活，`senderName` 是它的称呼，`hop` 是第几手
- inbox 的 `mentions` 含被 @ 的自己（标 `isMe: true`），正文里 @自己 显示为 `@名字（你）`；`addressedToMe: true` 表示这条就是冲你来的
- /ids 卡片登记按 open_id 优先匹配（配置里的称呼和飞书显示名不同也不会重复登记）；回复 @ 了主人和发送者以外的人时发纯文本（对方可能是没登记的机器人，卡片 @ 叫不动它）
- 交活给别的机器人：`ats` 里写它的名字即可；到 `botMaxHops`（默认 3）手后不能再 @ 机器人，直接回复结果
- 机器人交来的活做完后，如果不需要对方继续，就**不要**再 @ 它（否则会来回接力）

## 断线补拉

daemon 重启或长连接重连后，自动把断线期间的消息拉回来补处理，worker 不用做任何事，这些消息照常出现在 inbox 里（只是来得晚一些）：

- 范围：最近 7 天活跃过的会话（最多 20 个，记在 `chats.json`），最多往回 `backfillMinutes` 分钟（默认 30，设 0 关闭）
- 已处理过的按 message_id 跳过（`seen.json`），不会重复回复
- 单聊用已有的 `im:message` 权限即可；群聊还要开通 `im:message.group_msg`（获取群组中所有消息，敏感权限，onboard 不会自动申请；用户要群聊补拉时再手动开通并发布版本）。没开就只补单聊，debug.log 里 `daemon.backfill` 记一条错误
- 超过 `backfillMinutes` 的断线，更早的消息不补；用户问起时如实说明

## 保活与自检

- `keepalive.sh --install-cron`：cron 每 5 分钟检查、开机后拉起；`--uninstall-cron` 移除
- hook 兜底：心跳停 90 秒直接调用 keepalive 拉起（不依赖 cron）；心跳停 10 分钟仍没救回、或 outbox 里的回复超过 3 分钟没发出，会唤醒 worker（payload 带 `health_issue`），worker 先跑 `bash keepalive.sh`、看 `daemon.log` 修复，再向用户报告；同一故障每小时最多提醒一次
- `npm run doctor`：只读自检，有 FAIL 退出码 1

## 外部影响

- 本机主动向外建 WebSocket 长连接收飞书事件，无需公网回调地址；出网可走 HTTP 代理（`proxy` 配置）
- 收到的图片/文件下载到本地 `incoming/`
- 同一飞书应用只应有一条长连接；daemon 自带单实例锁，多开会被拒绝

## 重要边界

- 消息处理逻辑（AI 后端）由部署者自己接 `inbox/`/`outbox/` 文件队列实现，本仓库只提供桥接层
- 群聊默认只响应 @（`groupPolicy: mention`），私聊全响应
- `secrets.env` 含应用密钥，绝不提交；外发文件白名单仅限 `outgoing/` 与 `/tmp`，拒绝 `*.env` 等敏感文件
- 卡片原地更新需要应用有"更新应用发送的消息"（`im:message:update`）权限并发布新版本；没开也能用，只是会多出一张卡
- `allowedOpenIds` 为空拒绝启动；只放自己的 open_id
