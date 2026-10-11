/** 卡片样式（replyStyle: "card"，默认）：状态卡原地更新、多段、竞态、失败回退、重启续用。不连网。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, textMsg, writeOutbox, waitFor, ls, sleep, httpError, cardText, cardTitle, FakeTransport } from "./helpers.js";
import { buildReplyCard } from "../reply-card.js";
import type { BridgeConfig } from "../config.js";

const CFG: BridgeConfig = { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1, replyStyle: "card" };
const tmpl = (c: unknown) => String((c as { header?: { template?: string } }).header?.template);
const footer = (c: unknown) => String(((c as any).body.elements[1] || {}).content || "");

test("卡片：回复很快 → 不发『处理中』，直接一张绿色『已完成』卡；@主人 变成卡片 @；页脚有耗时", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 200 });
  await env.bridge.onMessage(textMsg("om_c1", "hi"));
  await writeOutbox(env, "om_c1", { text: "好的 @主人\n\n| a | b |\n|---|---|\n| 1 | 2 |" });
  await env.bridge.drain();
  await sleep(260);
  const cs = env.t.cards();
  assert.equal(cs.length, 1);
  assert.equal(cs[0].method, "replyCard");
  assert.equal(cardTitle(cs[0].arg), "✅ 已完成");
  assert.equal(tmpl(cs[0].arg), "green");
  assert.match(cardText(cs[0].arg), /好的 <at id=ou_owner><\/at>/);
  assert.match(footer(cs[0].arg), /耗时/);
  assert.equal((cs[0].arg as any).schema, "2.0");
  assert.equal(env.t.delivered.filter((c) => c.method === "replyText").length, 0, "不再有纯文本消息");
});

test("卡片：回复慢 → 先发蓝色『处理中』卡，回复到了原地更新成绿色，不多发一条", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 20 });
  await env.bridge.onMessage(textMsg("om_c2", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_c2")?.cardMessageId));
  const ack = env.t.cards()[0];
  assert.equal(ack.method, "replyCard");
  assert.equal(tmpl(ack.arg), "blue");
  assert.match(cardTitle(ack.arg), /处理中/);
  await writeOutbox(env, "om_c2", { text: "最终答案" });
  await env.bridge.drain();
  const cs = env.t.cards();
  assert.deepEqual(cs.map((c) => c.method), ["replyCard", "updateCard"]);
  assert.equal(cs[1].target, env.routes.get("om_c2")!.cardMessageId);
  assert.equal(tmpl(cs[1].arg), "green");
  assert.equal(cardText(cs[1].arg), "最终答案");
  assert.equal(env.routes.get("om_c2")!.cardFinal, true);
});

test("卡片：长回复分段 → 第 1 段更新状态卡，其余新发，标题带 (i/n)，页脚只在最后一段", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 10 });
  await env.bridge.onMessage(textMsg("om_c3", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_c3")?.cardMessageId));
  const long = Array.from({ length: 150 }, (_, i) => `第${i}行 ` + "x".repeat(40)).join("\n");
  await writeOutbox(env, "om_c3", { text: long });
  await env.bridge.drain();
  const cs = env.t.cards().slice(1);
  assert.ok(cs.length >= 2);
  assert.equal(cs[0].method, "updateCard");
  assert.ok(cs.slice(1).every((c) => c.method === "replyCard"));
  assert.match(cardTitle(cs[0].arg), /（1\/\d+）/);
  assert.equal(footer(cs[0].arg), "");
  assert.match(footer(cs[cs.length - 1].arg), /耗时/);
  assert.equal(new Set(cs.slice(1).map((c) => c.uuid)).size, cs.length - 1, "每段独立 uuid");
});

test("卡片：『处理中』卡还在发送途中回复就到了 → 等它发完再原地更新，不会出现两张卡", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 10 });
  const release = env.t.hold("replyCard");
  await env.bridge.onMessage(textMsg("om_c4", "hi"));
  await sleep(30); // ack 已开始、卡在发送中
  await writeOutbox(env, "om_c4", { text: "答案" });
  const d = env.bridge.drain();
  await sleep(20);
  release();
  await d;
  const cs = env.t.cards();
  assert.deepEqual(cs.map((c) => c.method), ["replyCard", "updateCard"]);
  assert.equal(cardText(cs[1].arg), "答案");
});

test("卡片：更新被飞书永久拒绝 → 退回新发一张；临时失败 → 下轮重试更新，不重复", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 10 });
  await env.bridge.onMessage(textMsg("om_c5", "hi"));
  await env.bridge.onMessage(textMsg("om_c6", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_c5")?.cardMessageId && env.routes.get("om_c6")?.cardMessageId));
  env.t.failNext("updateCard", httpError(400, 230031, "card expired"));
  await writeOutbox(env, "om_c5", { text: "A" });
  await env.bridge.drain();
  const c5 = env.t.delivered.filter((c) => c.target === "om_c5" && c.method === "replyCard");
  assert.equal(c5.length, 2, "处理中 + 退回新发的答案卡");
  assert.equal(cardText(c5[1].arg), "A");

  env.t.failNext("updateCard", httpError(503));
  await writeOutbox(env, "om_c6", { text: "B" });
  await env.bridge.drain();
  assert.ok(!(await ls(env.paths.sent)).includes("om_c6.json"));
  env.clock.now += 5000; // 退避到点
  await env.bridge.drain();
  await waitFor(async () => (await ls(env.paths.sent)).includes("om_c6.json"));
  const ups = env.t.delivered.filter((c) => c.method === "updateCard" && cardText(c.arg) === "B");
  assert.equal(ups.length, 1);
  assert.equal(env.t.delivered.filter((c) => c.target === "om_c6" && c.method === "replyCard").length, 1, "只有最初的处理中卡");
});

test("卡片：回复只有文件 → 文件发出后状态卡更新为『已完成』，不会一直停在处理中", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 10 });
  await env.bridge.onMessage(textMsg("om_c7", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_c7")?.cardMessageId));
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const f = join(env.paths.outgoing, "r.txt");
  await writeFile(f, "x");
  await writeOutbox(env, "om_c7", { text: "", file: f });
  await env.bridge.drain();
  const up = env.t.delivered.find((c) => c.method === "updateCard");
  assert.ok(up);
  assert.equal(tmpl(up!.arg), "green");
  assert.equal(env.routes.get("om_c7")!.cardFinal, true);
});

test("卡片：daemon 重启后，回复仍原地更新之前发出的『处理中』卡（message_id 持久化在 routes.json）", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 10 });
  await env.bridge.onMessage(textMsg("om_c8", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_c8")?.cardMessageId));
  const mid = env.routes.get("om_c8")!.cardMessageId!;
  await sleep(30); // routes.json 落盘
  const t2 = new FakeTransport();
  const env2 = await makeEnv({ root: env.root, config: CFG, t: t2 });
  await writeOutbox(env2, "om_c8", { text: "重启后的答案" });
  await env2.bridge.drain();
  assert.deepEqual(t2.cards().map((c) => [c.method, c.target]), [["updateCard", mid]]);
});

test("卡片：超时未认领 → 状态卡变红『已超时』；斜杠命令回复是标题卡", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 10 });
  await env.bridge.onMessage(textMsg("om_c9", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_c9")?.cardMessageId));
  env.clock.now += 61_000;
  await env.bridge.sweep();
  const up = env.t.delivered.find((c) => c.method === "updateCard");
  assert.equal(tmpl(up!.arg), "red");
  assert.match(cardTitle(up!.arg), /超时/);

  await env.bridge.onMessage(textMsg("om_s1", "/ping"));
  const s = env.t.delivered.find((c) => c.target === "om_s1")!;
  assert.equal(s.method, "replyCard");
  assert.equal(cardTitle(s.arg), "🏓 Pong");
  assert.equal(cardText(s.arg), "pong 🏓");
});

test("卡片构造：会话列表预览、页脚转义、空正文", () => {
  const c = buildReplyCard({ status: "done", markdown: "# 标题\n```js\nx\n```\n[链接](https://a.b)", footer: ["耗时 3秒", "<x>"] }) as any;
  assert.equal(c.config.update_multi, true);
  assert.match(c.config.summary.content, /标题 \[代码\] 链接/);
  assert.ok(!/<x>/.test(c.body.elements[1].content));
  const e = buildReplyCard({ status: "running", markdown: "" }) as any;
  assert.equal(e.body.elements[0].content, " ");
});
