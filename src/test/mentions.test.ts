/** @ 他人 / 机器人 @ 机器人接力：入站 mentions、出站 ats 白名单、渲染、接力上限、限频、防循环。不连网。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, textMsg, writeOutbox, waitFor, ls, readJson, cardText } from "./helpers.js";
import { applyAts, parseHop, resolveAts } from "../mentions.js";
import { validateConfig, type BridgeConfig } from "../config.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

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
  // 给助手的名单含自己（按消息顺序，标 isMe），正文里 @自己 保留成「（你）」
  assert.deepEqual(item.mentions, [{ openId: BOT, name: "本机", isMe: true }, { openId: "ou_zhang", name: "张三" }, { openId: "ou_peerb", name: "小B" }]);
  assert.equal(item.text, "@本机（你） @张三 @小B 帮忙看下");
  assert.equal(item.addressedToMe, true);
  assert.equal(item.fromBot, undefined);
  // 回复路由（决定能 @ 谁）不含自己
  assert.deepEqual(env.routes.get("om_g1")!.mentions, [{ openId: "ou_zhang", name: "张三" }, { openId: "ou_peerb", name: "小B" }]);
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
  assert.equal(item.text, "@本机（你） 请汇总");
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

test("ats（classic）：只 @ 主人时照常分段，只在第一段 @；陌生 open_id 被丢弃并记日志", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "classic" } });
  await env.bridge.onMessage(groupMsg("om_o1"));
  const long = Array.from({ length: 150 }, (_, i) => `第${i}行 ` + "x".repeat(40)).join("\n");
  await writeOutbox(env, "om_o1", { text: long, ats: ["主人", "ou_stranger"] });
  await env.bridge.drain();
  const sends = env.t.textOpts.filter((x) => x.target === "om_o1");
  assert.ok(sends.length >= 2);
  assert.deepEqual(sends[0].opts.ats!.map((a) => a.id), ["ou_owner", "ou_owner"]);
  assert.deepEqual(sends[1].opts.ats!.map((a) => a.id), ["ou_owner"]);
  assert.ok(!sends[0].opts.forceText);
  assert.ok(env.logs.some((l) => l.event === "daemon.ats_dropped" && JSON.stringify(l.data).includes("ou_stranger")));
});

test("ats（卡片）：只 @ 主人时仍是卡片，<at id> 只出现一次", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "card" } });
  await env.bridge.onMessage(groupMsg("om_o2"));
  await writeOutbox(env, "om_o2", { text: "@主人 那边好了", ats: ["主人"] });
  await env.bridge.drain();
  const md = cardText(env.t.cards()[0].arg);
  assert.equal(md.split("ou_owner").length - 1, 1);
});

test("@ 了主人和发送者以外的人（可能是没登记的机器人）：整段一条纯文本，不加接力标记", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "card" } });
  await env.bridge.onMessage(groupMsg("om_o3"));
  await writeOutbox(env, "om_o3", { text: "@张三 那边好了", ats: ["张三"] });
  await env.bridge.drain();
  const sends = env.t.textOpts.filter((x) => x.target === "om_o3");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].opts.forceText, true);
  assert.ok(sends[0].opts.ats!.some((a) => a.id === "ou_zhang"));
  assert.ok(!/〔接力/.test(sends[0].text));
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

const findButtons = (c: any): any[] => JSON.stringify(c ?? null).includes('"button"') ? (c.body.elements as any[]).filter((e) => e.tag === "button") : [];
const click = (env: any, messageId: string, value: unknown, eventId: string) =>
  env.bridge.onCardAction({ messageId, chatId: "oc_1", operatorOpenId: "ou_owner", eventId, value });

test("/ids 卡片：询问是否填入 config.json；点按钮才写入，立即生效；其他配置不动", async () => {
  const env = await makeEnv({ config: { ...CFG, peerBots: [{ name: "小B", appId: "cli_peerb" }], replyStyle: "classic" } });
  await writeFile(env.paths.config, JSON.stringify({ allowedOpenIds: ["ou_owner"], peerBots: [{ name: "小B", appId: "cli_peerb" }], other: 1 }, null, 2));
  await env.bridge.onMessage(textMsg("om_l1", "@_user_1 /ids @_user_2 @_user_3", { chatType: "group", mentions: [m("@_user_1", "本机", BOT), m("@_user_2", "小B", "ou_learned"), m("@_user_3", "小C", "ou_c")] }));
  const reply = env.t.calls.find((c) => c.target === "om_l1" && c.method === "replyCard")!;
  const btns = findButtons(reply.arg);
  assert.deepEqual(btns.map((b) => b.text.content), ["填入 小B 的 open_id", "登记 小C 为协作机器人"]);
  // 没点之前不写
  assert.equal((await readJson(env.paths.config)).peerBots[0].openId, undefined);
  await click(env, "om_card1", btns[0].behaviors[0].value, "ev1");
  let cfg = await readJson(env.paths.config);
  assert.equal(cfg.peerBots[0].openId, "ou_learned");
  assert.equal(cfg.peerBots[0].appId, "cli_peerb");
  assert.equal(cfg.other, 1);
  const upd = env.t.calls.find((c) => c.method === "updateCard" && c.target === "om_card1")!;
  assert.match(JSON.stringify(upd.arg), /已填入配置[\s\S]*不用重启/);
  // 点按钮不会交给助手
  assert.ok(!(await ls(env.paths.inbox)).some((f) => f.startsWith("card_")));
  // 新登记小C
  await click(env, "om_card1", btns[1].behaviors[0].value, "ev2");
  cfg = await readJson(env.paths.config);
  assert.deepEqual(cfg.peerBots[1], { name: "小C", openId: "ou_c" });
  // 立即生效：小C 发来的消息被接受，回复能 @ 到小B
  const fromC = botMsg("om_l9", "@_user_1 结果");
  fromC.senderOpenId = "ou_c";
  fromC.senderAppId = "cli_unknown";
  await env.bridge.onMessage(fromC);
  assert.ok((await ls(env.paths.inbox)).includes("om_l9.json"));
  await env.bridge.onMessage(textMsg("om_l2", "让小B看看"));
  await writeOutbox(env, "om_l2", { text: "好", ats: ["小B"] });
  await env.bridge.drain();
  assert.ok(env.t.textOpts.find((x) => x.target === "om_l2")!.opts.ats!.some((a) => a.id === "ou_learned"));
  // 已填好的不再出按钮
  await env.bridge.onMessage(textMsg("om_l3", "@_user_1 /ids @_user_2", { chatType: "group", mentions: [m("@_user_1", "本机", BOT), m("@_user_2", "小B", "ou_learned")] }));
  assert.equal(findButtons(env.t.calls.find((c) => c.target === "om_l3")!.arg).length, 0);
});

test("/ids 卡片：非白名单的人点按钮无效；重复点击只处理一次", async () => {
  const env = await makeEnv({ config: { ...CFG, peerBots: [{ name: "小B", appId: "cli_peerb" }] } });
  await writeFile(env.paths.config, JSON.stringify({ peerBots: [{ name: "小B", appId: "cli_peerb" }] }));
  const val = { mfb: "peer_fill", name: "小B", openId: "ou_x1" };
  await env.bridge.onCardAction({ messageId: "om_c2", chatId: "oc_1", operatorOpenId: "ou_stranger", eventId: "e0", value: val });
  assert.equal((await readJson(env.paths.config)).peerBots[0].openId, undefined);
  await click(env, "om_c2", val, "e1");
  await click(env, "om_c2", val, "e1");
  assert.equal(env.t.calls.filter((c) => c.method === "updateCard").length, 1);
});

test("协作机器人 @ 本机器人时：按 appId 记下它的 open_id（只在内存，不改配置文件），之后能 @ 回它", async () => {
  const env = await makeEnv({ config: { ...CFG, peerBots: [{ name: "小B", appId: "cli_peerb" }], replyStyle: "classic" } });
  await writeFile(env.paths.config, JSON.stringify({ peerBots: [{ name: "小B", appId: "cli_peerb" }] }));
  await env.bridge.onMessage(botMsg("om_l5", "@_user_1 干活"));
  assert.equal((await readJson(env.paths.config)).peerBots[0].openId, undefined);
  await env.bridge.onMessage(textMsg("om_l6", "让小B看看"));
  await writeOutbox(env, "om_l6", { text: "好", ats: ["小B"] });
  await env.bridge.drain();
  assert.ok(env.t.textOpts.find((x) => x.target === "om_l6")!.opts.ats!.some((a) => a.id === "ou_peerb"));
});

test("实测问题：1号收到接力后 @ 了没登记的 2号——要发纯文本（卡片 @ 不触发机器人）并继续计手数", async () => {
  const env = await makeEnv({ config: { ...CFG, replyStyle: "card" } });
  const msg = botMsg("om_r1", "@_user_1 @_user_2 主人有令\n〔接力 1/3〕");
  msg.mentions = [m("@_user_1", "本机", BOT), m("@_user_2", "2号", "ou_two")];
  await env.bridge.onMessage(msg);
  await writeOutbox(env, "om_r1", { text: "@2号 主人喊你", ats: ["2号"] });
  await env.bridge.drain();
  const s = env.t.textOpts.find((x) => x.target === "om_r1")!;
  assert.equal(s.opts.forceText, true);
  assert.ok(s.opts.ats!.some((a) => a.id === "ou_two"));
  assert.match(s.text, /〔接力 2\/3〕$/);
});


test("多个机器人被同一条消息 @：每个机器人看到的「（你）」是它自己；群里 @ 了自己再发斜杠命令照常执行", async () => {
  const env = await makeEnv({ config: CFG });
  await env.bridge.onMessage(textMsg("om_multi", "@_user_1 @_user_2 大家在干嘛", { chatType: "group", mentions: [m("@_user_1", "1号", "ou_one"), m("@_user_2", "本机", BOT)] }));
  const item = await readJson(join(env.paths.inbox, "om_multi.json"));
  assert.equal(item.text, "@1号 @本机（你） 大家在干嘛");
  assert.deepEqual(item.mentions.map((x: any) => [x.name, Boolean(x.isMe)]), [["1号", false], ["本机", true]]);
  await env.bridge.onMessage(textMsg("om_slash", "@_user_1 /ping", { chatType: "group", mentions: [m("@_user_1", "本机", BOT)] }));
  assert.ok(!(await ls(env.paths.inbox)).includes("om_slash.json"), "斜杠命令不进 inbox");
});

test("富文本（post）里 @自己 也标「（你）」", async () => {
  const env = await makeEnv({ config: CFG });
  const post = { zh_cn: { content: [[{ tag: "at", user_id: BOT, user_name: "本机" }, { tag: "text", text: " 看下" }]] } };
  await env.bridge.onMessage(textMsg("om_post2", "", { msgType: "post", content: JSON.stringify(post) }));
  const item = await readJson(join(env.paths.inbox, "om_post2.json"));
  assert.equal(item.text, "@本机（你） 看下");
});

test("groupPolicy=open：群里没 @ 本机器人的消息 addressedToMe=false、正文没有（你）", async () => {
  const env = await makeEnv({ config: { ...CFG, groupPolicy: "open" } as any });
  await env.bridge.onMessage(textMsg("om_open", "大家好 @_user_1", { chatType: "group", mentions: [m("@_user_1", "张三", "ou_zhang")] }));
  const item = await readJson(join(env.paths.inbox, "om_open.json"));
  assert.equal(item.addressedToMe, false);
  assert.ok(!/（你）/.test(item.text));
  await env.bridge.onMessage(textMsg("om_p2p", "你好"));
  assert.equal((await readJson(join(env.paths.inbox, "om_p2p.json"))).addressedToMe, true);
});

test("富文本（post）里 @自己 再写斜杠命令，照常当命令执行", async () => {
  const env = await makeEnv({ config: CFG });
  const post = { zh_cn: { content: [[{ tag: "at", user_id: BOT, user_name: "本机" }, { tag: "text", text: " /ping" }]] } };
  await env.bridge.onMessage(textMsg("om_post3", "", { chatType: "group", msgType: "post", content: JSON.stringify(post), mentions: [m("@_user_1", "本机", BOT)] }));
  assert.ok(!(await ls(env.paths.inbox)).includes("om_post3.json"));
});

test("/ids：配置里的称呼和飞书显示名不同，但 open_id 已登记 → 不再出登记按钮；点旧按钮也只更新原条目不重复", async () => {
  const peerBots = [{ name: "小B", openId: "ou_peerb", appId: "cli_peerb" }];
  const env = await makeEnv({ config: { ...CFG, peerBots } });
  await writeFile(env.paths.config, JSON.stringify({ allowedOpenIds: ["ou_owner"], peerBots }, null, 2));
  await env.bridge.onMessage(textMsg("om_n1", "@_user_1 /ids @_user_2", { chatType: "group", mentions: [m("@_user_1", "本机", BOT), m("@_user_2", "muse助手1号选手", "ou_peerb")] }));
  assert.equal(findButtons(env.t.calls.find((c) => c.target === "om_n1")!.arg).length, 0);
  await click(env, "om_card9", { mfb: "peer_fill", name: "muse助手1号选手", openId: "ou_peerb" }, "ev9");
  const cfg = await readJson(env.paths.config);
  assert.equal(cfg.peerBots.length, 1);
  assert.equal(cfg.peerBots[0].name, "小B");
});
