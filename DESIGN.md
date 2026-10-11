# muse-feishu 桥接 · 设计说明

目标：在飞书里直接跟 Muse（本平台助手）聊天，国内免代理可用。

## 架构

```
飞书平台
  │  WSS 长连接（本机主动向外建连，无需公网回调）
  ▼
daemon.js（Node 常驻进程）
  │  FeishuTransport（复用自 @caichengle/omp-feishu-lark 的 transport.ts）
  │  收消息 → 去重 → 白名单 → 写 inbox/<messageId>.json
  │  等 outbox/<messageId>.json → transport.replyText 回飞书
  ▼
hook feishu-inbox-watch（轮询 inbox/）
  │  有新文件 → wake 唤醒助手
  ▼
Muse 助手（被唤醒后）
   读 inbox → 思考/调工具 → 写 outbox/<messageId>.json → 删 inbox/<messageId>.json
```

关键点：

- "智能"不在 daemon 里，daemon 只负责飞书传输 + 文件队列；真正的回答由被 hook 唤醒的助手产生。
- inbox/outbox/sent 三个目录解耦两端，任何一端崩溃重启都不丢消息（inbox 文件没被消费会再次唤醒）。

## 0.2.0 变更（测试审查后修复）

原版在模拟飞书环境下实测复现的问题与修复：

| # | 问题（0.1.0） | 修复（0.2.0） |
|---|---|---|
| 1 | waitReply 与排空定时器各读一遍 outbox → 同一回复整条发两遍 | 唯一投递路径 outbox.ts：认领 + 同 id 互斥 + 单实例锁 + 飞书 uuid 幂等 |
| 2 | 发送失败被吞掉照样归档 sent/ → 回复静默丢失 | 永久错误进 failed/ 附原因；临时错误计次重试 |
| 3 | 排空失败时文件留在 outbox，每 5 秒从头重发已成功部分 → 刷屏 | 分部件进度落盘，只补未发部分；窗口计次上限 |
| 4 | 卡片点击用合成 id 调 reply 接口 → 必然失败 | routes.json 记回复目标 = 被点击的卡片；回调按 event_id 去重 |
| 5 | 60 秒内同内容（前 200 字）视为重复 → 用户连发两次"好"第二条被吞 | 改为按 message_id 持久化去重（重启后有效） |
| 6 | secrets.env.example 用 APP_ID，代码读 FEISHU_APP_ID → 照示例配置无法启动 | 两种键名都认，示例改为新键名 |
| 7 | keepalive 的 pgrep 模式写死 `muse-feishu/dist`，仓库目录叫 muse-feishu-bridge 时永远判为"不存在" → 每次 cron 都拉起一个新实例 | 移植企业微信 0.2.1 的 keepalive：pid + starttime + token 身份核实、realpath、flock |
| 8 | 无单实例保护，两个 daemon 同时排空 → 重复回复 | daemon 自己 O_EXCL 持有 daemon.lock，陈旧锁安全回收 |
| 9 | outbox 的 file 可以是任意路径（实测能把 secrets.env 发出去） | 只允许 outgoing/ 与 /tmp；敏感文件名、硬链接、ROOT 内其他文件一律拒绝 |
| 10 | 超时后先说"请重发"，迟到的回复照发 → 用户重发后拿到两份 | 未认领的超时消息移到 expired/ 写墓碑；已认领的只提醒一次、不放弃 |
| 11 | 图片/文件/富文本消息把原始 JSON 塞给助手（只有 image_key） | 解析 post 正文、下载附件到 incoming/<id>/ |
| 12 | groupPolicy 写死 open：群里不 @ 机器人也触发 | 默认 mention，可配置 |
| 13 | 群聊文本里的 @_user_1 占位符原样传给助手 | @机器人 去掉，@他人 换成名字 |
| 14 | 长回复里的 @主人 走 post 消息时 `<at>` 标签原样显示 | 含 @主人 时 post 降级为 text；卡片用 `<at id=…></at>` |
| 15 | 按 4000 字符切分会把代码块切成两半，后半段渲染错乱 | textsplit.ts：代码块跨段时补齐围栏，一段 = 一条消息 |
| 16 | HTTP 200 + 业务 code≠0 被当成发送成功 | assertOk() 统一转成 FeishuApiError，并按 code 区分可重试 / 永久 |
| 17 | 事件处理里 await chat.get（最长 15 秒），超过飞书 3 秒应答要求会被重推 | 处理器立即返回，其余异步进行 |
| 18 | 心跳非原子写、不反映长连接状态 | 原子写，带 connected 与启动令牌 |
| 19 | .mov/.avi 当 mp4 上传；文件整个读两遍；下载无大小上限 | 只有 .mp4 走 media；下载限 maxDownloadMB |
| 20 | src/ 与 src/vendor/ 两套重复代码（vendor 也被编译） | 删除 vendor/；strict 模式编译通过 |

## 0.3.9 变更：会话上下文

实测确认：hook 的 wake 只有 reason + payload，每次是全新 worker；memory_search 搜不到聊天内容；平台没有往 side chat 追加 turn 的接口。原来 worker 只能翻 sent/ 里自己的回复反推，用户原文处理完就删了。

- 新增 `history.ts`：按 `conversationKey()`（私聊/群/话题）把用户消息和已发出的回复追加到 `history/<会话>.jsonl`
- inbox 新增 `conversation` / `history`（最近 `historyTurns` 轮，默认 20，总字数 ≤ `historyMaxChars`）/ `historyFile`
- 回复在发送成功后才记（从 sent/ 读回），失败或空回复不记
- `/new` 清空当前会话；巡检按 `historyTtlDays`（默认 7）清理旧会话；文件超 2 MB 压缩为最近 400 行
- `historyTurns: 0` 完全关闭，行为与 0.3.8 相同

## 已知限制

- 未连接真实飞书验证：media（视频）消息是否必须带封面 image_key、uuid 幂等窗口、`card.action.trigger` 的 event_id 字段位置，需联调确认
- hook（feishu-inbox-watch）不在本仓库，"认领"按"inbox/<id>.json 不再存在"判断
- 卡片回调缺 event_id 与 token 时，按 卡片 + 操作人 + value 哈希去重（10 分钟内同值重复点击只入队一次）

## 目录

```
muse-feishu/
  src/transport.ts 等  复用自 @caichengle/omp-feishu-lark v0.4.69（上游 AX1202/pi-feishu-lark，MIT），0.2.0 有改动
  src/muse-backend.ts  inbox/outbox 文件队列（原子写 tmp+rename，长轮询等回复）
  src/daemon.ts        主程序：配置加载、去重、白名单、消息路由
  dist/                tsc 编译产物（node 直接运行）
  config.json          非密钥配置：domain/groupPolicy/language/白名单/回复超时
  secrets.env          App ID/Secret（600 权限，不提交，见 secrets.env.example）
  inbox/ outbox/ sent/ 消息队列目录
```

## 复用说明

- `transport.ts` 复用：长连接建立/重连、事件分发、群 @ 过滤、回复分片、
  文本/富文本卡片/post 自动选择、失败重试、表情回应。`strict:false` 与原工程对齐。
- 未复用：message-handler / conversation-manager / rpc-worker-pool（耦合 pi-coding-agent 的
  extension host 与 RPC worker 协议，Muse 平台没有该运行时）。

## 配置

- `config.json`：`groupPolicy`（群里 "mention"= 仅 @ 才回，"open"= 全回）、`allowedOpenIds`
  （飞书用户 open_id 白名单，空=拒绝启动）、`replyTimeoutMin`（默认 20 分钟）。
- `secrets.env`：`APP_ID` / `APP_SECRET`，权限 600。

## 安全

- 白名单：非白名单用户发消息只会收到"只服务主人"的拒绝语，不会唤醒助手。
- 密钥只存 `secrets.env`，不进日志、不进记忆、不出现在命令行参数。

## 当前状态（2026-10-01）

- [x] 工程搭建、编译通过（0.2.0 起 strict）
- [x] `--check-config` 无密钥/占位符两种失败路径验证
- [x] 队列逻辑验证（enqueue 原子写、waitReply 取回+归档、超时返回 null）
- [x] hook 脚本编写 + dry_run 验证（wake/silent 两条路径），保持禁用
- [x] systemd 单元文件已写，未启用
- [ ] 飞书自建应用创建（用户侧）与 App ID/Secret 安全录入
- [ ] 真实长连接联调：私聊收发、群 @、白名单
- [ ] 联调通过后：启用 hook + systemd 服务，观察 24 小时

## 联调步骤（等密钥）

1. 用户按飞书开放平台建自建应用（机器人能力、im:message 等权限、长连接订阅
   im.message.receive_v1、发布版本），通过安全方式给 App ID/Secret。
2. 写入 `secrets.env`（chmod 600），跑 `npm run check-config`。
3. 手动 `npm start`，手机飞书给机器人发消息，验证收到回复。
4. 通过后：`hooks.enable feishu-inbox-watch`，`systemctl --user enable --now muse-feishu`。
