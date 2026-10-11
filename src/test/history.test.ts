/** 0.3.9 会话历史：worker 每次都是新会话，上下文靠桥落盘并写进 inbox 的 history 字段。 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEnv, textMsg, writeOutbox, readJson, ls } from "./helpers.js";
import { validateConfig } from "../config.js";
import { HistoryStore, historyFileName } from "../history.js";

const OWNER = { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1 };
const inbox = (env: { paths: { inbox: string } }, id: string) => readJson(join(env.paths.inbox, `${id}.json`));
const m = (key: string, name: string, open_id: string) => ({ key, name, id: { open_id } });

/** 模拟一轮：用户发消息 → 助手写 outbox → daemon 发出 */
async function turn(env: Awaited<ReturnType<typeof makeEnv>>, id: string, text: string, reply: string, extra = {}) {
  await env.bridge.onMessage(textMsg(id, text, extra));
  await writeOutbox(env, id, { text: reply });
  await env.bridge.drain();
}

test("H1 私聊：第一条没有 history；回复发出后，下一条带上一轮的问与答，并给出 historyFile", async () => {
  const env = await makeEnv({ config: OWNER });
  await turn(env, "om_1", "我叫小蔡，记住", "好的，小蔡");
  const first = await inbox(env, "om_1");
  assert.equal(first.history, undefined);
  assert.equal(first.conversation, "p2p:ou_owner");

  await env.bridge.onMessage(textMsg("om_2", "我叫什么？"));
  const second = await inbox(env, "om_2");
  assert.deepEqual(
    second.history.map((h: { role: string; text: string }) => [h.role, h.text]),
    [
      ["user", "我叫小蔡，记住"],
      ["assistant", "好的，小蔡"],
    ],
  );
  assert.ok(!second.history.some((h: { text: string }) => h.text === "我叫什么？"), "不含本条");
  assert.ok(existsSync(second.historyFile));
  assert.equal(second.historyFile, join(env.paths.history, historyFileName("p2p:ou_owner")));
});

test("H2 会话隔离：私聊、群、群里的话题各记各的", async () => {
  const env = await makeEnv({ config: OWNER });
  const at = { chatType: "group" as const, chatId: "oc_g", mentions: [m("@_user_1", "本机", "ou_bot")] };
  await turn(env, "om_p", "私聊里说的", "私聊回复");
  await turn(env, "om_g", "@_user_1 群里说的", "群回复", at);
  await turn(env, "om_t", "@_user_1 话题里说的", "话题回复", { ...at, threadId: "omt_1" });

  await env.bridge.onMessage(textMsg("om_g2", "@_user_1 接着说", at));
  const g2 = await inbox(env, "om_g2");
  assert.equal(g2.conversation, "group:oc_g");
  assert.deepEqual(g2.history.map((h: { text: string }) => h.text), ["@本机（你） 群里说的", "群回复"]);
  assert.equal(g2.history[0].senderName, "主人", "群里标出谁说的");

  await env.bridge.onMessage(textMsg("om_t2", "@_user_1 话题接着说", { ...at, threadId: "omt_1" }));
  const t2 = await inbox(env, "om_t2");
  assert.equal(t2.conversation, "group:oc_g:thread:omt_1");
  assert.deepEqual(t2.history.map((h: { text: string }) => h.text), ["@本机（你） 话题里说的", "话题回复"]);

  await env.bridge.onMessage(textMsg("om_p2", "私聊接着说"));
  const p2 = await inbox(env, "om_p2");
  assert.deepEqual(p2.history.map((h: { text: string }) => h.text), ["私聊里说的", "私聊回复"]);
});

test("H3 落盘：daemon 重启（新进程同一 ROOT）后历史还在", async () => {
  const a = await makeEnv({ config: OWNER });
  await turn(a, "om_1", "重启前说的", "重启前回的");
  const b = await makeEnv({ config: OWNER, root: a.root });
  await b.bridge.onMessage(textMsg("om_2", "重启后"));
  const it = await inbox(b, "om_2");
  assert.deepEqual(it.history.map((h: { text: string }) => h.text), ["重启前说的", "重启前回的"]);
});

test("H4 /new 清空本会话上下文：daemon 直接回复、不进 inbox；之后的消息没有 history；别的会话不受影响", async () => {
  const env = await makeEnv({ config: OWNER });
  const at = { chatType: "group" as const, chatId: "oc_g", mentions: [m("@_user_1", "本机", "ou_bot")] };
  await turn(env, "om_1", "旧话题", "旧回复");
  await turn(env, "om_g", "@_user_1 群里的", "群回复", at);
  await env.bridge.onMessage(textMsg("om_new", "/new"));
  assert.ok(!(await ls(env.paths.inbox)).includes("om_new.json"));
  assert.match(env.t.texts().at(-1) || "", /已清空/);
  await env.bridge.onMessage(textMsg("om_2", "新话题"));
  assert.equal((await inbox(env, "om_2")).history, undefined);
  await env.bridge.onMessage(textMsg("om_g2", "@_user_1 群里接着", at));
  assert.equal((await inbox(env, "om_g2")).history.length, 2, "群里的历史没被私聊的 /new 清掉");
});

test("H5 截断：historyTurns 限条数、historyMaxChars 限总字数（丢最旧的）；单条超长截断并注明", async () => {
  const env = await makeEnv({ config: { ...OWNER, historyTurns: 2, historyMaxChars: 3000 } });
  for (let i = 1; i <= 4; i++) await turn(env, `om_${i}`, `问${i}`, `答${i}`);
  await env.bridge.onMessage(textMsg("om_5", "问5"));
  assert.deepEqual((await inbox(env, "om_5")).history.map((h: { text: string }) => h.text), ["问3", "答3", "问4", "答4"]);

  await writeOutbox(env, "om_5", { text: "长".repeat(2500) });
  await env.bridge.drain();
  await env.bridge.onMessage(textMsg("om_6", "问6"));
  const h = (await inbox(env, "om_6")).history as { text: string }[];
  const total = h.reduce((n, e) => n + e.text.length, 0);
  assert.ok(total <= 3000, `总字数 ${total} ≤ 3000`);
  assert.match(h.at(-1)!.text, /已截断，原文 2500 字/);
  assert.equal(h.at(-1)!.text.startsWith("长".repeat(2000)), true);
});

test("H6 historyTurns=0 关闭：inbox 不带 history 字段，也不写 history/ 目录", async () => {
  const env = await makeEnv({ config: { ...OWNER, historyTurns: 0 } });
  await turn(env, "om_1", "a", "b");
  await env.bridge.onMessage(textMsg("om_2", "c"));
  const it = await inbox(env, "om_2");
  assert.equal(it.history, undefined);
  assert.equal(it.historyFile, undefined);
  assert.equal(existsSync(env.paths.history), false);
});

test("H7 没回复（text 为空）不记 assistant；发文件记成 [发送文件: 名字]；附件记路径不记内容", async () => {
  const env = await makeEnv({ config: OWNER });
  await env.bridge.onMessage(textMsg("om_1", "不用回"));
  await writeOutbox(env, "om_1", { text: "" });
  await env.bridge.drain();
  await env.bridge.onMessage(textMsg("om_img", "", { msgType: "image", content: JSON.stringify({ image_key: "img_1" }) }));
  await writeFile(join(env.paths.outgoing, "x.txt"), "x");
  await writeOutbox(env, "om_img", { text: "看到了", file: join(env.paths.outgoing, "x.txt") });
  await env.bridge.drain();
  const raw = await readFile(join(env.paths.history, historyFileName("p2p:ou_owner")), "utf8");
  const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.role), ["user", "user", "assistant"]);
  assert.match(rows[1].text, /^\[图片: .*incoming/);
  assert.equal(rows[2].text, "看到了\n[发送文件: x.txt]");
});

test("H8 巡检清理：超过 historyTtlDays 没动的会话文件被删", async () => {
  const env = await makeEnv({ config: { ...OWNER, historyTtlDays: 1 } });
  await turn(env, "om_1", "a", "b");
  const f = join(env.paths.history, historyFileName("p2p:ou_owner"));
  assert.ok(existsSync(f));
  env.clock.now += 2 * 24 * 3600_000;
  await env.bridge.sweep();
  assert.equal(existsSync(f), false);
});

test("H9 HistoryStore：半行（崩溃写到一半）跳过；会话名里的特殊字符不会穿出目录", async () => {
  const env = await makeEnv({ config: OWNER });
  const s = new HistoryStore(env.paths.history, { turns: 5, maxChars: 10000, maxEntryChars: 100, ttlMs: 1e9, now: Date.now });
  await s.append("../../etc/x", { role: "user", text: "hi", ts: "t" });
  assert.ok(historyFileName("../../etc/x").indexOf("/") < 0);
  const { appendFile } = await import("node:fs/promises");
  await appendFile(s.fileFor("../../etc/x"), '{"role":"assistant","te');
  assert.deepEqual((await s.recent("../../etc/x")).map((e) => e.text), ["hi"]);
});

test("H10 配置校验：historyTurns / historyMaxChars / historyTtlDays", () => {
  const base = { allowedOpenIds: ["ou_a"] };
  assert.deepEqual(validateConfig({ ...base, historyTurns: 0, historyMaxChars: 500, historyTtlDays: 0.5 }).errors, []);
  assert.ok(validateConfig({ ...base, historyTurns: -1 }).errors.some((e) => e.includes("historyTurns")));
  assert.ok(validateConfig({ ...base, historyTurns: 1.5 }).errors.some((e) => e.includes("historyTurns")));
  assert.ok(validateConfig({ ...base, historyMaxChars: 10 }).errors.some((e) => e.includes("historyMaxChars")));
  assert.ok(validateConfig({ ...base, historyTtlDays: 0 }).errors.some((e) => e.includes("historyTtlDays")));
});
