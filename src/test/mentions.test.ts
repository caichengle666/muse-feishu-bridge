/** @ 他人 / 机器人 @ 机器人接力：入站 mentions、出站 ats 白名单、渲染、接力上限、限频、防循环。不连网。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, textMsg, writeOutbox, waitFor, ls, readJson, cardText } from "./helpers.js";
import { applyAts, parseHop, resolveAts } from "../mentions.js";
import { validateConfig, type BridgeConfig } from "../config.js";
import { join } from "node:path";

const BOT = "ou_bot"; // FakeTransport.getBotOpenId()
const m = (key: string, name: string, open_id: string) => ({ key, name, id: { open_id } });
const PEERS = [{ name: "小B", openId: "ou_peerb", appId: "cli_peerb" }];
const CFG: BridgeConfig = { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 5, peerBots: PEERS };

/** 群消息：主人 @本机器人 @张三 @小B */
const groupMsg = (id: string, text = "@_user_1 @_user_2 @_user_3 帮忙看下") =>
  textMsg(id, text, { chatType: "group", mentions: [m("@_user_1", "本机", BOT), m("@_user_2", "张三", "ou_zhang"), m("@_user_3", "小B", "ou_peerb")] });

/** 协作机器人发来的消息 */
const botMsg = (id: string, text: string, opts: { appId?: string; mentionSelf?: boolean; chatId?: string } = {}) =>
  textMsg(id, text, {
    chatType: "group",
    chatId: opts.chatId ?? "oc_1",
    senderType: "bot",
    senderOpenId: "ou_peerb",
    senderAppId: opts.appId ?? "cli_peerb",
    mentions: opts.mentionSelf === false ? [] : [m("@_user_1", "本机", BOT)],
  });

// ------------------------------------------------------------ 纯函数

test("applyAts：卡片 / 文本标签；正文 @名字 就地替换，没提到的开头补；同一人只 @ 一次；长名字优先", () => {
  const t = [{ id: "ou_zhang", name: "张三", prefix: true }, { id: "ou_zf", name: "张三丰", prefix: true }, { id: "ou_li", name: "李四", prefix: true }];
  assert.equal(applyAts("@张三丰 和 @张三 看下", t, "card"), "<at id=ou_li></at> <at id=ou_zf></at> 和 <at id=ou_zhang></at> 看下");
  assert.equal(applyAts("看下", [{ id: "ou_zhang", name: "张三", prefix: true }], "text"), '<at user_id="ou_zhang">张三</at> 看下');
  assert.equal(applyAts("看下", [{ id: "ou_x", name: "", prefix: true }], "text"), '<at user_id="ou_x">某人</at> 看下');
  // 兼容：@主人 只映射主人；主人既在 ats 又在正文 → 只 @ 一次
  const owner = { id: "ou_owner", name: "主人" };
  assert.equal(applyAts("@主人 好了", [owner], "card"), "<at id=ou_owner></at> 好了");
  assert.equal(applyAts("@主人 好了", [{ ...owner, prefix: true }, owner], "card"), "<at id=ou_owner></at> 好了");
  assert.equal(applyAts("好了", [owner], "card"), "好了", "@主人 兼容映射不主动补 @");
  assert.equal(applyAts("x", [{ id: "all", name: "所有人", prefix: true }, { id: "../x", name: "a", prefix: true }], "text"), "x", "非 open_id 忽略");
});

test("resolveAts：只允许本条消息被 @ 的、发送者、主人、协作机器人；其他 open_id 和 @所有人 丢弃", () => {
  const r = resolveAts({
    ats: ["ou_zhang", "小B", "主人", "@张三", "ou_stranger", "all", "所有人", 42],
    ownerOpenId: "ou_owner",
    senderOpenId: "ou_owner",
    mentions: [{ openId: "ou_zhang", name: "张三" }],
    peers: PEERS,
  });
  assert.deepEqual(r.targets.map((x) => x.id), ["ou_zhang", "ou_peerb", "ou_owner"]);
  assert.deepEqual([...r.peerIds], ["ou_peerb"]);
  assert.deepEqual(r.dropped, ["ou_stranger", "all", "所有人"]);
  assert.equal(r.targets.find((x) => x.id === "ou_owner")!.name, "主人");
});

test("parseHop：读出并去掉文末接力标记", () => {
  assert.deepEqual(parseHop("做完了\n〔接力 2/3〕"), { text: "做完了", hop: 2 });
  assert.deepEqual(parseHop("普通消息"), { text: "普通消息" });
});

test("配置校验：peerBots", () => {
  assert.equal(validateConfig({ allowedOpenIds: ["ou_a"], peerBots: PEERS }).errors.length, 0);
  assert.ok(validateConfig({ allowedOpenIds: ["ou_a"], peerBots: [{ name: "" }] as any }).errors.length >= 2);
  assert.ok(validateConfig({ allowedOpenIds: ["ou_a"], peerBots: [{ name: "x", appId: "cli_x" }] }).warnings.some((w) => /openId/.test(w)));
  assert.ok(validateConfig({ allowedOpenIds: ["ou_a"], botMaxHops: 0 }).errors.length > 0);
});

// ------------------------------------------------------------ 入站

test("inbox 携带 mentions（真实 open_id，不含本机器人）；routes.json 也存一份", async () => {
  const env = await makeEnv({ config: CFG });
  await env.bridge.onMessage(groupMsg("om_g1"));
  const item = await readJson(join(env.paths.inbox, "om_g1.json"));
  assert.deepEqual(item.mentions, [{ openId: "ou_zhang", name: "张三" }, { openId: "ou_peerb", name: "小B" }]);
  assert.equal(item.text, "@张三 @小B 帮忙看下");
  assert.equal(item.fromBot, undefined);
  assert.deepEqual(env.routes.get("om_g1")!.mentions, item.mentions);
});

test("机器人消息：未登记的丢弃；登记但没 @ 本机器人的丢弃（A @ B 后 B 的普通回复不会回流到 A）；登记且 @ 了 → 入队，标 fromBot、读出接力手数", async () => {
  const env = await makeEnv({ config: CFG });
  const other = botMsg("om_b1", "@_user_1 干活", { appId: "cli_other" });
  other.senderOpenId = "ou_other1";
  await env.bridge.onMessage(other);
  const stranger = botMsg("om_b2", "@_user_1 干活");
  stranger.senderOpenId = "ou_otherbot";
  stranger.senderAppId = undefined;
  await env.bridge.onMessage(stranger);
  await env.bridge.onMessage(botMsg("om_b3", "B 的结果（没 @ A）", { mentionSelf: false }));
  assert.deepEqual(await ls(env.paths.inbox), []);
  assert.ok(env.logs.some((l) => l.event === "daemon.blocked_bot_not_peer"));
  assert.ok(env.logs.some((l) => l.event === "daemon.blocked_bot_not_mentioned"));

  await env.bridge.onMessage(botMsg("om_b4", "@_user_1 请汇总\n〔接力 2/3〕"));
  const item = await readJson(join(env.paths.inbox, "om_b4.json"));
  assert.equal(item.fromBot, true);
  assert.equal(item.senderName, "小B");
  assert.equal(item.hop, 2);
  assert.equal(item.text, "请汇总");
  // 机器人发斜杠命令不执行
  await env.bridge.onMessage(botMsg("om_b5", "@_user_1 /ping"));
  assert.ok((await ls(env.paths.inbox)).includes("om_b5.json"));
  assert.equal(env.t.calls.filter((c) => c.target === "om_b5").length, 0);
  // 用户白名单照旧
  await env.bridge.onMessage(textMsg("om_u1", "hi", { senderOpenId: "ou_stranger" }));
  assert.ok(!(await ls(env.paths.inbox)).includes("om_u1.json"));
});

test("机器人消息限频：同一会话每分钟超过 botMaxPerMinute 的丢弃，其他会话不受影响", async () => {
  const env = await makeEnv({ config: { ...CFG, botMaxPerMinute: 3 } });
  for (let i = 0; i < 5; i++) await env.bridge.onMessage(botMsg(`om_r${i}`, "@_user_1 x"));
  await env.bridge.onMessage(botMsg("om_rx", "@_user_1 x", { chatId: "oc_2" }));
  assert.deepEqual(await ls(env.paths.inbox), ["om_r0.json", "om_r1.json", "om_r2.json", "om_rx.json"]);
  env.clock.now += 61_000;
  await env.bridge.onMessage(botMsg("om_r9", "@_user_1 x"));
  assert.ok((await ls(env.paths.inbox)).includes("om_r9.json"));
});

// ------------------------------------------------------------ 出站

test("ats（classic）：只在第一段 @，后面几段只保留 @主人 兼容；陌生 open_id 被丢弃并记日志", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "classic" } });
  await env.bridge.onMessage(groupMsg("om_o1"));
  const long = Array.from({ length: 150 }, (_, i) => `第${i}行 ` + "x".repeat(40)).join("\n");
  await writeOutbox(env, "om_o1", { text: long, ats: ["ou_zhang", "ou_stranger"] });
  await env.bridge.drain();
  const sends = env.t.textOpts.filter((x) => x.target === "om_o1");
  assert.ok(sends.length >= 2);
  assert.deepEqual(sends[0].opts.ats!.map((a) => [a.id, Boolean(a.prefix)]), [["ou_zhang", true], ["ou_owner", false]]);
  assert.deepEqual(sends[1].opts.ats!.map((a) => a.id), ["ou_owner"]);
  assert.ok(!sends[0].opts.forceText);
  assert.ok(env.logs.some((l) => l.event === "daemon.ats_dropped" && JSON.stringify(l.data).includes("ou_stranger")));
});

test("ats（卡片）：卡片里渲染成 <at id>；ats 含主人且正文有 @主人 时只 @ 一次", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "card" } });
  await env.bridge.onMessage(groupMsg("om_o2"));
  await writeOutbox(env, "om_o2", { text: "@主人 张三那边好了", ats: ["张三", "主人"] });
  await env.bridge.drain();
  const md = cardText(env.t.cards()[0].arg);
  assert.equal(md, "<at id=ou_zhang></at> <at id=ou_owner></at> 张三那边好了");
  assert.equal(md.split("ou_owner").length - 1, 1);
});

test("接力：ats 含协作机器人 → 整段一条纯文本（不用卡片）、文末带〔接力 1/3〕；处理中卡片被收尾成已完成", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "card" }, ackDelayMs: 10 });
  await env.bridge.onMessage(groupMsg("om_h1"));
  await waitFor(() => Boolean(env.routes.get("om_h1")?.cardMessageId));
  const long = Array.from({ length: 150 }, (_, i) => `第${i}行 ` + "x".repeat(40)).join("\n");
  await writeOutbox(env, "om_h1", { text: `@小B 请把下面整理成表格\n${long}`, ats: ["小B"] });
  await env.bridge.drain();
  const sends = env.t.textOpts.filter((x) => x.target === "om_h1");
  assert.equal(sends.length, 1, "整段一条，免得后面几段对方收不到");
  assert.equal(sends[0].opts.forceText, true);
  assert.ok(sends[0].opts.ats!.some((a) => a.id === "ou_peerb" && a.prefix));
  assert.match(sends[0].text, /\n〔接力 1\/3〕$/);
  const up = env.t.delivered.find((c) => c.method === "updateCard");
  assert.ok(up, "处理中卡被更新为已完成");
  assert.equal(env.routes.get("om_h1")!.cardFinal, true);
});

test("接力上限：收到第 3 手（〔接力 3/3〕）后回复里不再 @ 机器人，并说明原因；@人 不受影响", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "classic" } });
  await env.bridge.onMessage(botMsg("om_l1", "@_user_1 继续\n〔接力 3/3〕"));
  await writeOutbox(env, "om_l1", { text: "我做完了，@小B 你再看看", ats: ["小B", "主人"] });
  await env.bridge.drain();
  const s = env.t.textOpts.find((x) => x.target === "om_l1")!;
  assert.ok(!s.opts.ats!.some((a) => a.id === "ou_peerb"));
  assert.ok(s.opts.ats!.some((a) => a.id === "ou_owner" && a.prefix));
  assert.ok(!s.opts.forceText);
  assert.match(s.text, /接力已达 3 手上限/);
  assert.ok(!/〔接力/.test(s.text));
  assert.ok(env.logs.some((l) => l.event === "daemon.bot_hop_limit"));
});

test("接力手数逐手 +1：机器人第 1 手转来 → 回 @ 机器人带〔接力 2/3〕", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "classic" } });
  await env.bridge.onMessage(botMsg("om_n1", "@_user_1 帮我查\n〔接力 1/3〕"));
  await writeOutbox(env, "om_n1", { text: "查好了", ats: ["小B"] });
  await env.bridge.drain();
  const s = env.t.textOpts.find((x) => x.target === "om_n1")!;
  assert.match(s.text, /〔接力 2\/3〕$/);
  // 发送者（协作机器人）本身也能被 @，按名字或 open_id
  assert.ok(s.opts.ats!.some((a) => a.id === "ou_peerb" && a.name === "小B"));
});

test("/ids：返回发送者和被 @ 对象在本应用里的 open_id", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "classic" } });
  await env.bridge.onMessage(textMsg("om_i1", "@_user_1 /ids @_user_2", { chatType: "group", mentions: [m("@_user_1", "本机", BOT), m("@_user_2", "小B", "ou_peerb")] }));
  const out = env.t.texts().join("\n");
  assert.match(out, /你：ou_owner/);
  assert.match(out, /小B：ou_peerb/);
  assert.deepEqual(await ls(env.paths.inbox), []);
});

// ------------------------------------------------------------ 可能出 bug 的场景

test("场景：名字是另一个名字的前缀（B 和 Bob）——@Bob 不能被拆成 @B + ob", () => {
  const t = [{ id: "ou_b", name: "B", prefix: true }];
  assert.equal(applyAts("@Bob 和 @B 看下", t, "text"), '@Bob 和 <at user_id="ou_b">B</at> 看下');
  assert.equal(applyAts("@B看下", t, "card"), "<at id=ou_b></at>看下");
  assert.equal(applyAts("@B.x 和 @B?", [{ id: "ou_b", name: "B.", prefix: true }], "card"), "<at id=ou_b></at>x 和 @B?", "名字里的正则字符按字面匹配");
});

test("场景：交给机器人的内容超长被分成多条——接力标记必须在带 @ 的第一条里（否则对方读不到手数，可能无限接力）", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "classic" } });
  await env.bridge.onMessage(groupMsg("om_s1"));
  const huge = "很长的内容。".repeat(5000); // 30000 字 > 单条 20000
  await writeOutbox(env, "om_s1", { text: huge, ats: ["小B"] });
  await env.bridge.drain();
  const sends = env.t.textOpts.filter((x) => x.target === "om_s1");
  assert.ok(sends.length >= 2);
  assert.match(sends[0].text, /〔接力 1\/3〕$/, "第一条（带 @ 的）有标记");
  assert.ok(sends[0].opts.ats!.some((a) => a.id === "ou_peerb"));
  for (const s of sends.slice(1)) assert.ok(!/〔接力/.test(s.text) && !s.opts.ats!.some((a) => a.id === "ou_peerb"));
});

test("场景：飞书重推同一条机器人消息——只处理一次，也不占限频名额", async () => {
  const env = await makeEnv({ config: { ...CFG, botMaxPerMinute: 2 } });
  await env.bridge.onMessage(botMsg("om_d1", "@_user_1 x"));
  await env.bridge.onMessage(botMsg("om_d1", "@_user_1 x"));
  await env.bridge.onMessage(botMsg("om_d2", "@_user_1 y"));
  assert.deepEqual(await ls(env.paths.inbox), ["om_d1.json", "om_d2.json"]);
});

test("场景：人假冒接力标记（用户消息末尾写〔接力 3/3〕）——不当真，仍按第 0 手", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "classic" } });
  await env.bridge.onMessage(textMsg("om_f1", "做个事\n〔接力 3/3〕"));
  const item = await readJson(join(env.paths.inbox, "om_f1.json"));
  assert.equal(item.hop, undefined);
  await writeOutbox(env, "om_f1", { text: "好", ats: ["小B"] });
  await env.bridge.drain();
  assert.match(env.t.textOpts.find((x) => x.target === "om_f1")!.text, /〔接力 1\/3〕$/);
});

test("场景：协作机器人发来的标记写了更大的上限（〔接力 3/99〕）——上限以本机配置为准", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "classic" } });
  await env.bridge.onMessage(botMsg("om_m1", "@_user_1 继续\n〔接力 3/99〕"));
  await writeOutbox(env, "om_m1", { text: "好", ats: ["小B"] });
  await env.bridge.drain();
  const s = env.t.textOpts.find((x) => x.target === "om_m1")!;
  assert.ok(!s.opts.ats!.some((a) => a.id === "ou_peerb"));
  assert.match(s.text, /上限/);
});

test("场景：主机器人同时派给 B、C，两个都 @ 回来——各算第 2 手，各处理一次，再派只能到第 3 手", async () => {
  const peers = [...PEERS, { name: "小C", openId: "ou_peerc", appId: "cli_peerc" }];
  const env = await makeEnv({ config: { ...CFG, peerBots: peers, replyStyle: "classic" } });
  await env.bridge.onMessage(botMsg("om_w1", "@_user_1 B 的结果\n〔接力 2/3〕"));
  const c = botMsg("om_w2", "@_user_1 C 的结果\n〔接力 2/3〕", { appId: "cli_peerc" });
  c.senderOpenId = "ou_peerc";
  await env.bridge.onMessage(c);
  const a = await readJson(join(env.paths.inbox, "om_w1.json"));
  const b = await readJson(join(env.paths.inbox, "om_w2.json"));
  assert.deepEqual([a.senderName, a.hop, b.senderName, b.hop], ["小B", 2, "小C", 2]);
  await writeOutbox(env, "om_w2", { text: "C 再确认下", ats: ["小C"] });
  await env.bridge.drain();
  assert.match(env.t.textOpts.find((x) => x.target === "om_w2")!.text, /〔接力 3\/3〕$/);
});

test("场景：助手正文写了 @小B 但忘了填 ats——按协作机器人名字自动识别成 @（否则 B 收不到，任务卡住）", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "card" } });
  await env.bridge.onMessage(textMsg("om_a1", "让小B查一下"));
  await writeOutbox(env, "om_a1", { text: "@小B 请查一下今天的日期" });
  await env.bridge.drain();
  const s = env.t.textOpts.find((x) => x.target === "om_a1");
  assert.ok(s, "按接力发纯文本");
  assert.equal(s!.opts.forceText, true);
  assert.match(s!.text, /〔接力 1\/3〕$/);
});

test("场景：登记了 appId 但没填 openId 的机器人——能收它的消息，回复 @ 不了时不报错、正常回复并记日志", async () => {
  const env = await makeEnv({ config: { ...CFG, peerBots: [{ name: "小D", appId: "cli_peerd" }], replyStyle: "classic" } });
  const d = botMsg("om_x1", "@_user_1 干活", { appId: "cli_peerd" });
  d.senderOpenId = "ou_peerd_seen";
  await env.bridge.onMessage(d);
  assert.ok((await ls(env.paths.inbox)).includes("om_x1.json"));
  await writeOutbox(env, "om_x1", { text: "好了", ats: ["小D"] });
  await env.bridge.drain();
  const s = env.t.textOpts.find((x) => x.target === "om_x1")!;
  // 发送者本身就在允许范围内：用它这条消息里的 open_id @ 回去，按接力处理
  assert.ok(s.opts.ats!.some((a) => a.id === "ou_peerd_seen"));
  assert.match(s.text, /〔接力 2\/3〕$/);
});
