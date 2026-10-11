/** 0.2.0 回归测试：投递引擎 / 去重 / 路由 / 超时 / 文本切分 / 错误分类 / 配置。不连网。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, link, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEnv, textMsg, writeOutbox, waitFor, ls, readJson, sleep, httpError, FakeTransport } from "./helpers.js";
import { splitReplyText } from "../textsplit.js";
import { FeishuApiError, assertOk, isPermanentFeishuError, isRetryableFeishuError } from "../feishu-retry.js";
import { runDelivery, partUuid, OutboxStore, type Channel } from "../outbox.js";
import { loadSecrets, parseEnvFile, validateConfig } from "../config.js";
import { SeenStore } from "../state.js";
import { resolveMentions } from "../bridge.js";
import { checkOutgoingFile } from "../files.js";

// ------------------------------------------------------------ 发送：唯一路径、不重复、不丢

test("P0-1 同一条回复只发一次：并发 drain ×5 + 入站等待，飞书收到的每段恰好一次", async () => {
  const env = await makeEnv();
  await env.bridge.onMessage(textMsg("om_a", "hi"));
  const long = Array.from({ length: 200 }, (_, i) => `第${i}行 ` + "x".repeat(40)).join("\n");
  await writeOutbox(env, "om_a", { text: long });
  const release = env.t.hold("replyText");
  const runs = [1, 2, 3, 4, 5].map(() => env.bridge.drain());
  await sleep(30);
  release();
  await Promise.all(runs);
  await waitFor(async () => (await ls(env.paths.sent)).includes("om_a.json"));
  const parts = splitReplyText(long);
  assert.equal(env.t.calls.filter((c) => c.method === "replyText").length, parts.length, "调用次数 = 段数，没有任何一段被发两次");
  assert.deepEqual(env.t.texts(), parts);
});

test("P0-2 发送失败不再被当作已发归档：永久错误进 failed/ 并写原因，临时错误留待重试", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "om_p", { text: "hello" });
  env.t.failNext("replyText", httpError(400, 230002, "Bot is not in the chat"));
  await env.bridge.drain();
  assert.deepEqual(await ls(env.paths.sent), []);
  assert.ok((await ls(env.paths.failed)).includes("om_p.json"));
  const why = await readJson(join(env.paths.failed, "om_p.reason.json"));
  assert.match(why.reason, /230002/);

  await writeOutbox(env, "om_t", { text: "hello" });
  const netErr = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  env.t.failNext("replyText", netErr);
  const r1 = await env.bridge.drain();
  assert.deepEqual(r1.retry, ["om_t"]);
  assert.ok((await ls(env.paths.outbox)).includes("om_t.json"), "临时错误：放回 outbox");
  await env.bridge.drain();
  assert.ok((await ls(env.paths.sent)).includes("om_t.json"));
  assert.deepEqual(env.t.texts(), ["hello"]);
});

test("P0-3 部分成功不会从头重发：第 1 段已发、第 2 段临时失败 → 下次只补第 2 段起", async () => {
  const env = await makeEnv();
  const text = Array.from({ length: 120 }, (_, i) => `L${i} ` + "y".repeat(40)).join("\n");
  const parts = splitReplyText(text);
  assert.ok(parts.length >= 2);
  await writeOutbox(env, "om_s", { text });
  env.t.failAt("replyText", 2, Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }));
  const r1 = await env.bridge.drain();
  assert.deepEqual(r1.retry, ["om_s"]);
  assert.deepEqual(env.t.texts(), [parts[0]]);
  await env.bridge.drain();
  const sends = env.t.calls.filter((c) => c.method === "replyText");
  assert.equal(sends.length, parts.length + 1, "第 1 段没有被重发，只有失败的第 2 段多试了一次");
  assert.deepEqual(env.t.texts(), parts);
});

test("P0-4 每段带稳定的飞书 uuid（崩溃后重发也被飞书去重）", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "om_u", { text: "a" });
  await env.bridge.drain();
  assert.equal(env.t.calls[0].uuid, partUuid("om_u", "text:0"));
  assert.ok(env.t.calls[0].uuid!.length <= 50);
  assert.notEqual(partUuid("om_u", "text:0"), partUuid("om_u", "text:1"));
  assert.notEqual(partUuid("om_u", "text:0"), partUuid("om_v", "text:0"));
});

test("P0-5 崩溃恢复：inflight 里的回复移回 outbox，凭进度只补未发部件；已发但未记进度的部件靠 uuid 去重", async () => {
  const env = await makeEnv();
  await writeFile(join(env.paths.outgoing, "r.pdf"), "pdf");
  await writeOutbox(env, "om_c", { text: "正文", file: join(env.paths.outgoing, "r.pdf") });
  // 模拟上次进程：认领后发出了 text:0（飞书已收到），但进度没落盘就崩了
  await rename(join(env.paths.outbox, "om_c.json"), join(env.paths.inflight, "om_c.json"));
  await env.t.replyText("om_c", "正文", { uuid: partUuid("om_c", "text:0") });
  const rec = await env.outbox.recoverInflight();
  assert.deepEqual(rec.requeued, ["om_c"]);
  await env.bridge.drain();
  assert.deepEqual(env.t.texts(), ["正文"], "飞书侧只有一条正文");
  assert.equal(env.t.delivered.filter((c) => c.method === "replyLocalFile").length, 1);
  assert.ok((await ls(env.paths.sent)).includes("om_c.json"));
});

test("P0-6 不能外发敏感文件：secrets.env / ROOT 内非 outgoing / 硬链接 / 允许范围外 都被拒，并通知用户", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "om_f", { text: "", file: env.paths.secrets });
  await env.bridge.drain();
  assert.equal(env.t.delivered.filter((c) => c.method === "replyLocalFile").length, 0);
  assert.match(env.t.texts()[0], /文件发送失败/);
  const opts = { root: env.root, allowedRoots: [join(env.root, "outgoing"), tmpdir()] };
  assert.equal((await checkOutgoingFile(join(env.root, "config.json"), opts)).ok, false);
  await writeFile(join(env.root, "notes.txt"), "x");
  assert.equal((await checkOutgoingFile(join(env.root, "notes.txt"), opts)).ok, false, "ROOT 内只允许 outgoing/");
  const hl = join(await mkdtemp(join(tmpdir(), "mfb-hl-")), "x.txt");
  await link(env.paths.secrets, hl);
  assert.equal((await checkOutgoingFile(hl, opts)).ok, false, "硬链接绕过");
  assert.equal((await checkOutgoingFile("/etc/passwd", opts)).ok, false);
  await writeFile(join(env.paths.outgoing, "ok.txt"), "x");
  assert.equal((await checkOutgoingFile(join(env.paths.outgoing, "ok.txt"), opts)).ok, true);
});

// ------------------------------------------------------------ 超时

test("P1-1 未被认领的超时消息：移到 expired/、写墓碑、提示重发；之后迟到的回复不再发出", async () => {
  const env = await makeEnv({ config: { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1 } });
  await env.bridge.onMessage(textMsg("om_x", "hi"));
  env.clock.now += 61_000;
  await env.bridge.sweep();
  assert.ok(!existsSync(join(env.paths.inbox, "om_x.json")));
  assert.ok(existsSync(join(env.paths.expired, "om_x.tombstone")));
  assert.match(env.t.texts()[0], /麻烦稍后再发一次/);
  await writeOutbox(env, "om_x", { text: "迟到的回复" });
  await env.bridge.drain();
  assert.ok(!env.t.texts().includes("迟到的回复"));
  assert.ok((await ls(env.paths.expired)).includes("om_x.json"));
});

test("P1-2 已认领但处理慢：只提醒一次『还在处理』，不放弃，回复到了照常发出", async () => {
  const env = await makeEnv({ config: { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1 } });
  await env.bridge.onMessage(textMsg("om_y", "hi"));
  await rename(join(env.paths.inbox, "om_y.json"), join(env.paths.inbox, "om_y.json.claimed")); // hook 认领
  env.clock.now += 61_000;
  await env.bridge.sweep();
  await env.bridge.sweep();
  assert.equal(env.t.texts().filter((x) => /还在处理/.test(x)).length, 1);
  await writeOutbox(env, "om_y", { text: "正式回复" });
  await env.bridge.drain();
  assert.ok(env.t.texts().includes("正式回复"));
});

test("P1-3 超时巡检基于 inbox 时间戳：daemon 重启后（新 bridge 实例）依然生效", async () => {
  const env = await makeEnv({ config: { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1 } });
  await env.bridge.onMessage(textMsg("om_r", "hi"));
  const env2 = await makeEnv({ root: env.root, config: { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1 } });
  env2.clock.now = env.clock.now + 61_000;
  await env2.bridge.sweep();
  assert.ok(existsSync(join(env.paths.expired, "om_r.tombstone")));
});

test("P1-4 ack：回复迟迟没来先发『收到』；回复已在 outbox 时不发 ack", async () => {
  const env = await makeEnv({ ackDelayMs: 40 });
  await env.bridge.onMessage(textMsg("om_k1", "hi"));
  await env.bridge.onMessage(textMsg("om_k2", "hi"));
  await writeOutbox(env, "om_k2", { text: "很快的回复" });
  await sleep(120);
  const acks = env.t.delivered.filter((c) => String(c.arg).startsWith("收到"));
  assert.deepEqual(acks.map((c) => c.target), ["om_k1"]);
});

// ------------------------------------------------------------ 入站

test("P1-5 去重按 message_id 持久化（重启后飞书重推不会二次入队）；同内容的不同消息不再被吞", async () => {
  const env = await makeEnv();
  await env.bridge.onMessage(textMsg("om_1", "好"));
  await env.bridge.onMessage(textMsg("om_2", "好"));
  await env.bridge.onMessage(textMsg("om_1", "好"));
  assert.deepEqual(await ls(env.paths.inbox), ["om_1.json", "om_2.json"]);
  await rename(join(env.paths.inbox, "om_1.json"), join(env.paths.inbox, "om_1.claimed"));
  const env2 = await makeEnv({ root: env.root });
  await env2.bridge.onMessage(textMsg("om_1", "好"));
  assert.ok(!(await ls(env.paths.inbox)).includes("om_1.json"));
  const s = new SeenStore(env.paths.seen);
  await s.load();
  assert.ok(s.has("om_1") && s.has("om_2"));
});

test("P1-6 白名单 fail-closed；非白名单不入队、不回复", async () => {
  const env = await makeEnv();
  await env.bridge.onMessage(textMsg("om_z", "hi", { senderOpenId: "ou_stranger" }));
  assert.deepEqual(await ls(env.paths.inbox), []);
  assert.equal(env.t.calls.length, 0);
  assert.ok(validateConfig({}).errors.length > 0);
  assert.ok(validateConfig({ allowedOpenIds: [] }).errors.length > 0);
  assert.equal(validateConfig({ allowedOpenIds: ["ou_a"] }).errors.length, 0);
});

test("P1-7 图片/文件消息：下载到 incoming/<id>/，inbox 给出本地路径（原版只给 image_key）", async () => {
  const env = await makeEnv();
  await env.bridge.onMessage(textMsg("om_img", "", { msgType: "image", content: JSON.stringify({ image_key: "img_v2_x" }) }));
  await env.bridge.onMessage(textMsg("om_file", "", { msgType: "file", content: JSON.stringify({ file_key: "file_v2_y", file_name: "../../报告.pdf" }) }));
  const a = await readJson(join(env.paths.inbox, "om_img.json"));
  assert.match(a.filePath, /incoming\/om_img\/1-image-1\.png$/);
  const b = await readJson(join(env.paths.inbox, "om_file.json"));
  assert.match(b.attachments[0].path, /incoming\/om_file\/1-报告\.pdf$/, "文件名去掉路径部分");
  assert.ok(existsSync(b.attachments[0].path));
});

test("P1-8 群聊 @ 占位符：@机器人 去掉，@其他人 换成名字；富文本（post）消息提取正文", async () => {
  assert.equal(resolveMentions("@_user_1 帮我看看 @_user_2", [
    { key: "@_user_1", name: "Muse", id: { open_id: "ou_bot" } },
    { key: "@_user_2", name: "张三", id: { open_id: "ou_z" } },
  ], "ou_bot"), "帮我看看 @张三");
  const env = await makeEnv();
  const post = { zh_cn: { title: "标题", content: [[{ tag: "text", text: "第一段" }], [{ tag: "img", image_key: "img_1" }]] } };
  await env.bridge.onMessage(textMsg("om_post", "", { msgType: "post", content: JSON.stringify(post) }));
  const it = await readJson(join(env.paths.inbox, "om_post.json"));
  assert.equal(it.text, "标题\n第一段");
  assert.equal(it.attachments.length, 1);
});

test("P1-9 卡片点击：回复发往被点击的卡片消息（不是合成 id）；同一回调重复推送只入队一次", async () => {
  const env = await makeEnv();
  const action = { messageId: "om_card1", chatId: "oc_1", operatorOpenId: "ou_owner", eventId: "ev_1", value: { k: 1 } };
  await env.bridge.onCardAction(action);
  await env.bridge.onCardAction(action);
  const inbox = await ls(env.paths.inbox);
  assert.equal(inbox.length, 1);
  const id = inbox[0].replace(/\.json$/, "");
  assert.match(id, /^card_[0-9a-f]{24}$/);
  await writeOutbox(env, id, { text: "已处理" });
  await env.bridge.drain();
  assert.deepEqual(env.t.delivered.map((c) => c.target), ["om_card1"]);
  await env.bridge.onCardAction({ ...action, operatorOpenId: "ou_stranger", eventId: "ev_2" });
  assert.equal((await ls(env.paths.inbox)).length, 1);
});

test("P1-10 找不到回复目标（非 om_ id 且无路由）→ failed/，不会无限重试", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "weird-id", { text: "x" });
  await env.bridge.drain();
  await env.bridge.drain();
  assert.ok((await ls(env.paths.failed)).includes("weird-id.json"));
  assert.equal(env.t.calls.length, 0);
});

test("P1-11 半截 JSON（助手非原子写）计次重试，不当成空回复发出", async () => {
  const env = await makeEnv();
  await writeOutbox(env, "om_h", '{"messageId":"om_h","text":"半');
  await env.bridge.drain();
  assert.equal(env.t.calls.length, 0);
  await writeOutbox(env, "om_h", { text: "完整" });
  await env.bridge.drain();
  assert.deepEqual(env.t.texts(), ["完整"]);
});

// ------------------------------------------------------------ 文本切分

test("P2-1 切分：代码块跨段时每段 ``` 成对；每段 ≤ 上限；内容不丢", () => {
  const code = "```python\n" + Array.from({ length: 150 }, (_, i) => `print(${i})  # ` + "z".repeat(40)).join("\n") + "\n```";
  const text = "前言\n\n" + code + "\n\n结尾";
  const parts = splitReplyText(text);
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    assert.ok(p.length <= 3000, `段长 ${p.length}`);
    assert.equal((p.match(/```/g) || []).length % 2, 0, "每段代码围栏成对");
  }
  const joined = parts.join("\n").replace(/\n```\n```python/g, "");
  for (let i = 0; i < 150; i += 37) assert.ok(joined.includes(`print(${i})`));
  assert.ok(parts[parts.length - 1].includes("结尾"));
});

test("P2-2 切分：超长单行按字符切且不切断 emoji；空文本不发", () => {
  const line = "😀".repeat(5000);
  const parts = splitReplyText(line, 1000);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join(""), line);
  assert.ok(parts.every((p) => !/[\uD800-\uDBFF]$/.test(p)));
  assert.deepEqual(splitReplyText("   \n "), []);
});

// ------------------------------------------------------------ 错误分类

test("P1-12 飞书错误分类：HTTP 200 + code≠0 也算失败；限频/网络可重试；4xx/业务码为永久", () => {
  assert.throws(() => assertOk({ code: 230002, msg: "bot not in chat" }), FeishuApiError);
  assert.doesNotThrow(() => assertOk({ code: 0, data: {} }));
  assert.equal(isRetryableFeishuError(httpError(429)), true);
  assert.equal(isRetryableFeishuError(httpError(400, 99991400)), true, "限频业务码即使 HTTP 400 也可重试");
  assert.equal(isRetryableFeishuError(new FeishuApiError(230020, "rate")), true);
  assert.equal(isRetryableFeishuError(Object.assign(new Error("x"), { code: "ECONNRESET" })), true);
  assert.equal(isPermanentFeishuError(httpError(400, 230011, "recalled")), true);
  assert.equal(isPermanentFeishuError(new FeishuApiError(230002, "")), true);
  assert.equal(isPermanentFeishuError(httpError(503)), false);
  assert.equal(isPermanentFeishuError(new Error("奇怪的本地错误")), false, "未知错误按临时处理（有次数上限）");
});

test("P1-13 临时错误按窗口计次：同一部件 1 小时内失败 5 次进 failed/", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mfb-ob-"));
  const store = new OutboxStore({ outbox: join(dir, "o"), sent: join(dir, "s"), failed: join(dir, "f"), expired: join(dir, "e"), progress: join(dir, "p"), inflight: join(dir, "i") });
  await store.init();
  await writeFile(join(dir, "o", "om_w.json"), JSON.stringify({ text: "x" }));
  const ch: Channel = { sendText: async () => { throw httpError(503); }, sendFile: async () => undefined, sendCard: async () => undefined, notify: async () => undefined };
  let now = 1_000_000;
  const results: string[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await runDelivery(store, { messageId: "om_w", text: "x" }, ch, { root: dir, allowedRoots: [], now: () => (now += 1000) });
    results.push(r.status);
  }
  assert.deepEqual(results, ["retry", "retry", "retry", "retry", "failed"]);
});

// ------------------------------------------------------------ 配置

test("P1-14 凭证键名：FEISHU_APP_ID 与示例里的 APP_ID 都认；引号、CRLF、BOM、export 前缀都能解析", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mfb-cfg-"));
  const p = join(dir, "secrets.env");
  await writeFile(p, "\uFEFFexport APP_ID=\"cli_a\"\r\nAPP_SECRET='sec'\r\n");
  const s = await loadSecrets(p, {});
  assert.equal(s.appId, "cli_a");
  assert.equal(s.appSecret, "sec");
  await writeFile(p, "FEISHU_APP_ID=cli_b\nFEISHU_APP_SECRET=x\nAPP_ID=old\n");
  assert.equal((await loadSecrets(p, {})).appId, "cli_b", "新键名优先");
  assert.deepEqual(parseEnvFile("A=1=2\n#B=3\n"), { A: "1=2" });
});

test("P1-12 inbox 写入失败：不静默丢失——撤销已见过、通知用户，修好后飞书同 id 再来可正常入队", async () => {
  const env = await makeEnv();
  const orig = env.backend.enqueue.bind(env.backend);
  env.backend.enqueue = async () => { throw new Error("ENOSPC: no space left on device"); };
  await env.bridge.onMessage(textMsg("om_e1", "你好"));
  await waitFor(() => env.t.calls.some((c) => c.method === "replyText" && String(c.arg).includes("没能交给助手")));
  assert.ok(env.logs.some((l) => l.event === "daemon.enqueue_failed"));
  assert.ok(!env.seen.has("om_e1"));
  env.backend.enqueue = orig;
  await env.bridge.onMessage(textMsg("om_e1", "你好"));
  assert.deepEqual(await ls(env.paths.inbox), ["om_e1.json"]);
});

test("P2-6 超长单行硬切时不把 @主人 切成两半", () => {
  for (let pad = 2980; pad < 3000; pad++) {
    const parts = splitReplyText("x".repeat(pad) + "@主人" + "y".repeat(50), 3000);
    assert.ok(parts.some((p) => p.includes("@主人")), `pad=${pad}`);
  }
});

test("P3-1 斜杠命令：白名单用户的 /ping /help /status 由 daemon 直接回复、不进 inbox；未登记的 /路径 照常交给助手；非白名单不响应", async () => {
  const env = await makeEnv();
  await env.bridge.onMessage(textMsg("om_s1", "/ping"));
  await env.bridge.onMessage(textMsg("om_s2", "  /HELP "));
  await env.bridge.onMessage(textMsg("om_s3", "/status"));
  await env.bridge.onMessage(textMsg("om_s4", "/tmp/a.log 帮我看下"));
  await env.bridge.onMessage(textMsg("om_s5", "/unknowncmd"));
  await env.bridge.onMessage(textMsg("om_s6", "/ping", { senderOpenId: "ou_stranger" }));
  const replies = (id: string) => env.t.calls.filter((c) => c.method === "replyText" && c.target === id).map((c) => String(c.arg));
  assert.deepEqual(replies("om_s1"), ["pong 🏓"]);
  assert.ok(replies("om_s2")[0].includes("/status"));
  assert.ok(replies("om_s3")[0].includes("长连接") && replies("om_s3")[0].includes("待处理"));
  assert.deepEqual(replies("om_s6"), []);
  assert.deepEqual(await ls(env.paths.inbox), ["om_s4.json", "om_s5.json"]);
});

test("E3 代理选择：HTTPS_PROXY 生效、NO_PROXY 命中直连、config 可强制 off / 覆盖；日志地址不含账号密码", async () => {
  const { chooseProxy, redact } = await import("../proxy.js");
  const T = "https://open.feishu.cn";
  assert.equal(chooseProxy(T, undefined, {}).url, null);
  assert.equal(chooseProxy(T, undefined, { HTTPS_PROXY: "http://u:p@px:3128" }).url, "http://u:p@px:3128");
  assert.equal(chooseProxy(T, undefined, { HTTPS_PROXY: "http://u:p@px:3128" }).label, "http://px:3128");
  assert.equal(chooseProxy(T, undefined, { https_proxy: "http://px:1", NO_PROXY: "localhost,.feishu.cn" }).url, null);
  assert.equal(chooseProxy(T, undefined, { HTTPS_PROXY: "http://px:1", NO_PROXY: "*" }).url, null);
  assert.equal(chooseProxy(T, undefined, { HTTPS_PROXY: "http://px:1", NO_PROXY: "feishu.cn.evil.com" }).url, "http://px:1");
  assert.equal(chooseProxy(T, "off", { HTTPS_PROXY: "http://px:1" }).url, null);
  assert.equal(chooseProxy(T, "http://cfg:8080", { HTTPS_PROXY: "http://px:1" }).url, "http://cfg:8080");
  assert.equal(redact("http://a:b@h:1/x"), "http://h:1");
});

test("E3 长连接真的走代理：ws 挂上 agent 后经 CONNECT 隧道连通（不挂则 ws 无视 HTTPS_PROXY）", async () => {
  const http = await import("node:http");
  const net = await import("node:net");
  const { WebSocketServer, WebSocket } = await import("ws");
  const { makeProxyAgent } = await import("../proxy.js");
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  wss.on("connection", (s) => s.send("hello"));
  const wsPort = (wss.address() as { port: number }).port;
  const connects: string[] = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, sock, head) => {
    connects.push(String(req.url));
    const [h, p] = String(req.url).split(":");
    const up = net.connect(Number(p), h, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const pPort = (proxy.address() as { port: number }).port;
  try {
    const got = await new Promise<string>((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`, { agent: makeProxyAgent(`http://127.0.0.1:${pPort}`) });
      ws.on("message", (m) => { res(String(m)); ws.close(); });
      ws.on("error", rej);
    });
    assert.equal(got, "hello");
    assert.deepEqual(connects, [`127.0.0.1:${wsPort}`]);
  } finally {
    wss.close();
    proxy.close();
  }
});

test("P0-#2 可选同文本去重：默认关闭（连发两次『好』都入队）；打开后窗口内同文本只入队一次，窗口外恢复", async () => {
  const env = await makeEnv();
  await env.bridge.onMessage(textMsg("om_d1", "好"));
  await env.bridge.onMessage(textMsg("om_d2", "好"));
  assert.deepEqual(await ls(env.paths.inbox), ["om_d1.json", "om_d2.json"]);
  const env2 = await makeEnv({ config: { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1, dedupSameTextSeconds: 10 } });
  await env2.bridge.onMessage(textMsg("om_x1", "好"));
  await env2.bridge.onMessage(textMsg("om_x2", "好"));
  await env2.bridge.onMessage(textMsg("om_x3", "不好"));
  env2.clock.now += 11_000;
  await env2.bridge.onMessage(textMsg("om_x4", "好"));
  assert.deepEqual(await ls(env2.paths.inbox), ["om_x1.json", "om_x3.json", "om_x4.json"]);
  assert.ok(env2.logs.some((l) => l.event === "daemon.dedup_same_text"));
});

test("P2-#9 字节上限：最坏情况（全 4 字节 emoji / 全中文）每段 UTF-8 字节数也远低于飞书 post/卡片 30KB 请求体上限", () => {
  for (const ch of ["中", "😀"]) {
    const parts = splitReplyText(ch.repeat(20000), 3000);
    for (const p of parts) assert.ok(Buffer.byteLength(p, "utf8") <= 12_100, `${ch}: ${Buffer.byteLength(p, "utf8")}`);
  }
});

test("STOP-1 /stop：中断本会话进行中的消息（未认领/已认领/已写 outbox），写 stop 标记，旧回复不再发出；别的会话不受影响；没任务时如实说", async () => {
  const env = await makeEnv();
  const { rename: mv, readFile: rf } = await import("node:fs/promises");
  const { existsSync: ex } = await import("node:fs");
  const { join: pj } = await import("node:path");
  await env.bridge.onMessage(textMsg("om_a", "帮我删掉 a 目录"));
  await env.bridge.onMessage(textMsg("om_b", "顺便再跑测试"));
  await env.bridge.onMessage(textMsg("om_c", "写个报告"));
  await env.bridge.onMessage(textMsg("om_x", "别的群的活", { chatId: "oc_2" }));
  await env.bridge.onMessage(textMsg("om_done", "早就回完的"));
  await writeOutbox(env, "om_done", { text: "完成" });
  await env.bridge.drain();
  await mv(pj(env.paths.inbox, "om_done.json"), pj(env.paths.root, "om_done.consumed")); // worker 已消费
  // om_a：hook 已认领、worker 在跑；om_b：还在 inbox；om_c：worker 已写出回复但还没发
  await mv(pj(env.paths.inbox, "om_a.json"), pj(env.paths.inbox, "om_a.json.claimed"));
  await writeOutbox(env, "om_c", { text: "报告内容" });
  await env.bridge.onMessage(textMsg("om_stop", "/stop"));
  const replies = (id: string) => env.t.calls.filter((c) => c.method === "replyText" && c.target === id).map((c) => String(c.arg));
  assert.ok(replies("om_stop")[0].includes("已停止 3 个"), replies("om_stop")[0]);
  assert.deepEqual((await ls(env.paths.inbox)).sort(), ["om_x.json"]);
  for (const id of ["om_a", "om_b", "om_c"]) {
    assert.ok(ex(pj(env.paths.expired, `${id}.stopped`)), id);
    assert.ok(env.outbox.hasTombstone(id), id);
  }
  assert.ok(!ex(pj(env.paths.expired, "om_done.stopped")));
  const stop = JSON.parse(await rf(pj(env.paths.stop, "oc_1.json"), "utf8"));
  assert.equal(stop.messageId, "om_stop");
  assert.deepEqual([...stop.cancelled].sort(), ["om_a", "om_b", "om_c"]);
  // worker 停得慢、之后才写出 om_a 的回复：不发
  await writeOutbox(env, "om_a", { text: "已删除 a 目录" });
  await env.bridge.drain();
  assert.deepEqual(replies("om_a"), []);
  assert.deepEqual(replies("om_c"), []);
  assert.ok(!env.t.texts().some((x) => x.includes("已删除") || x.includes("报告内容")));
  // 新指令照常
  await env.bridge.onMessage(textMsg("om_new", "改成只删 b"));
  assert.ok((await ls(env.paths.inbox)).includes("om_new.json"));
  // 再 /stop：只中断 om_new
  await env.bridge.onMessage(textMsg("om_stop2", "/stop"));
  assert.ok(replies("om_stop2")[0].includes("已停止 1 个"));
  await env.bridge.onMessage(textMsg("om_stop3", "/stop"));
  assert.ok(replies("om_stop3")[0].includes("没有进行中"));
  // 另一个会话的不动
  assert.ok(!env.outbox.hasTombstone("om_x"));
  // /help 里有 /stop
  await env.bridge.onMessage(textMsg("om_h", "/help"));
  assert.ok(replies("om_h")[0].includes("/stop"));
});

test("STOP-2 卡片模式：/stop 把\"处理中\"卡改成\"已停止\"", async () => {
  const env = await makeEnv({ ackDelayMs: 1, config: { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1, replyStyle: "card" } as never });
  await env.bridge.onMessage(textMsg("om_k", "长任务"));
  await waitFor(() => env.t.cards().length > 0);
  await sleep(20);
  await env.bridge.idle();
  await env.bridge.onMessage(textMsg("om_ks", "/stop"));
  const t = env.t.texts().join("\n");
  assert.ok(t.includes("已被 /stop 中断"), JSON.stringify(env.t.calls.map((c) => [c.method, c.target])) + t);
  assert.ok(t.includes("已停止 1 个"), t);
});
