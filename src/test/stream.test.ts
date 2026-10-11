/** 流式输出（打字机）：stream/<id>.jsonl → 状态卡。CardKit 卡片实体与 PATCH 回退两条路径。不连网。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, textMsg, writeOutbox, waitFor, httpError, cardText, cardTitle, FakeTransport, type Env } from "./helpers.js";
import { parseStreamText, streamDisplayText, STREAM_DISPLAY_CHARS } from "../stream.js";
import type { BridgeConfig } from "../config.js";

const CFG: BridgeConfig = { allowedOpenIds: ["ou_owner"], replyTimeoutMin: 1, replyStyle: "card" };

/** 带 CardKit 能力的假 transport */
class KitTransport extends FakeTransport {
  entities = new Map<string, unknown>();
  kit: { op: string; cardId: string; seq?: number; arg?: unknown }[] = [];
  private n = 0;
  async createCardEntity(card: object) {
    await this.rec("createCardEntity", "", card);
    const id = `card_${++this.n}`;
    this.entities.set(id, card);
    this.kit.push({ op: "create", cardId: id, arg: card });
    return id;
  }
  async replyCardEntity(messageId: string, cardId: string, uuid?: string) {
    await this.rec("replyCardEntity", messageId, cardId, uuid);
    return `om_entity_${cardId}`;
  }
  async updateCardEntity(cardId: string, card: object, sequence: number) {
    await this.rec("updateCardEntity", cardId, card);
    this.kit.push({ op: "update", cardId, seq: sequence, arg: card });
  }
  async streamCardText(cardId: string, _el: string, content: string, sequence: number) {
    await this.rec("streamCardText", cardId, content);
    this.kit.push({ op: "text", cardId, seq: sequence, arg: content });
  }
  async setCardStreaming(cardId: string, on: boolean, sequence: number) {
    await this.rec("setCardStreaming", cardId, on);
    this.kit.push({ op: on ? "stream_on" : "stream_off", cardId, seq: sequence });
  }
}

async function stream(env: Env, id: string, ...texts: string[]) {
  await mkdir(env.paths.stream, { recursive: true });
  for (const t of texts) await appendFile(join(env.paths.stream, `${id}.jsonl`), JSON.stringify({ text: t }) + "\n");
}

test("stream 解析：逐行拼接、坏行/半行忽略、done 标记；超长截断并补齐代码围栏", () => {
  const r = parseStreamText('{"text":"第一段\\n\\n"}\n坏行\n{"text":"第二段"}\n{"done":true}\n{"text":"半');
  assert.equal(r.text, "第一段\n\n第二段");
  assert.equal(r.done, true);
  const short = streamDisplayText("abc");
  assert.deepEqual(short, { text: "abc", truncated: false });
  const long = "```js\n" + "x".repeat(STREAM_DISPLAY_CHARS + 10);
  const d = streamDisplayText(long);
  assert.equal(d.truncated, true);
  assert.match(d.text, /x\n```\n\n…（内容较长/);
});

test("CardKit：处理中卡是卡片实体；流式先全量换卡、再 settings 打开流式，之后逐次推全文（sequence 递增）；最终回复先关流式再全量更新", async () => {
  const t = new KitTransport();
  const env = await makeEnv({ config: CFG, ackDelayMs: 10, t });
  await env.bridge.onMessage(textMsg("om_s1", "写篇文章"));
  await waitFor(() => Boolean(env.routes.get("om_s1")?.cardId));
  const r0 = env.routes.get("om_s1")!;
  assert.equal(r0.cardMessageId, "om_entity_card_1");
  assert.equal(t.calls.filter((c) => c.method === "replyCard").length, 0, "没有走普通卡片");

  await stream(env, "om_s1", "第一段。\n\n");
  await env.bridge.pumpStreams();
  env.clock.now += 1000;
  await stream(env, "om_s1", "第二段。");
  await env.bridge.pumpStreams();

  const ops1 = t.kit.filter((k) => k.cardId === "card_1" && k.op !== "create");
  assert.deepEqual(ops1.slice(0, 3).map((k) => k.op), ["update", "stream_on", "text"], "先换卡，再打开流式模式，之后增量推文本");
  assert.equal(cardTitle(ops1[0].arg), "✍️ 正在输出");
  assert.equal(cardText(ops1[0].arg), "第一段。");
  assert.equal(ops1[2].arg, "第一段。\n\n第二段。");
  assert.equal(env.routes.get("om_s1")!.cardStreaming, true);

  await writeOutbox(env, "om_s1", { text: "第一段。\n\n第二段。完整版" });
  await env.bridge.drain();
  const ops = t.kit.filter((k) => k.cardId === "card_1" && k.op !== "create");
  const last2 = ops.slice(-2);
  assert.deepEqual(last2.map((k) => k.op), ["stream_off", "update"]);
  assert.equal(cardTitle(last2[1].arg), "✅ 已完成");
  assert.equal(cardText(last2[1].arg), "第一段。\n\n第二段。完整版");
  const seqs = ops.map((k) => k.seq!);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "sequence 严格递增");
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(existsSync(join(env.paths.stream, "om_s1.jsonl")), false, "回复发出后 stream 文件被清理");
  assert.equal(env.routes.get("om_s1")!.cardFinal, true);

  // 再写 stream 也不会改动已完成的卡
  await stream(env, "om_s1", "迟到");
  const before = t.kit.length;
  await env.bridge.pumpStreams();
  assert.equal(t.kit.length, before);
});

test("CardKit：流式内容先于『处理中』卡到达 → 立即发卡（不再等 ack 延时），且只发一张", async () => {
  const t = new KitTransport();
  const env = await makeEnv({ config: CFG, ackDelayMs: 60_000, t });
  await env.bridge.onMessage(textMsg("om_s2", "hi"));
  await stream(env, "om_s2", "马上开始");
  await env.bridge.pumpStreams();
  assert.equal(t.calls.filter((c) => c.method === "replyCardEntity").length, 1);
  assert.equal(cardText(t.kit.find((k) => k.op === "update")!.arg), "马上开始");
});

test("没有 cardkit 权限 → 自动回退普通卡片，流式改为 PATCH 逐段刷新，最终回复照常原地更新", async () => {
  const t = new KitTransport();
  t.failNext("createCardEntity", httpError(400, 99991672, "Access denied"));
  const env = await makeEnv({ config: CFG, ackDelayMs: 10, t });
  await env.bridge.onMessage(textMsg("om_s3", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_s3")?.cardMessageId));
  assert.equal(env.routes.get("om_s3")!.cardId, undefined);
  assert.ok(env.logs.some((l) => l.event === "daemon.cardkit_disabled"));

  await stream(env, "om_s3", "进度一");
  await env.bridge.pumpStreams();
  const up = t.cards().filter((c) => c.method === "updateCard");
  assert.equal(up.length, 1);
  assert.equal(cardText(up[0].arg), "进度一");
  assert.equal((up[0].arg as any).config.streaming_mode, undefined, "普通卡片不带流式模式");

  await writeOutbox(env, "om_s3", { text: "完成" });
  await env.bridge.drain();
  const last = t.cards().at(-1)!;
  assert.equal(last.method, "updateCard");
  assert.equal(cardText(last.arg), "完成");
  // 之后的消息也不再尝试 CardKit
  await env.bridge.onMessage(textMsg("om_s4", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_s4")?.cardMessageId));
  assert.equal(t.calls.filter((c) => c.method === "createCardEntity").length, 1);
});

test("流式：节流（1 秒内只推一次）、/stop 后不再推、streamReplies=false 关闭、classic 模式不推", async () => {
  const t = new KitTransport();
  const env = await makeEnv({ config: CFG, ackDelayMs: 10, t });
  await env.bridge.onMessage(textMsg("om_s5", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_s5")?.cardId));
  await stream(env, "om_s5", "a");
  await env.bridge.pumpStreams();
  await stream(env, "om_s5", "b");
  await env.bridge.pumpStreams(); // 同一时刻：被节流
  assert.equal(t.kit.filter((k) => k.op === "update" || k.op === "text").length, 1);
  env.clock.now += 1000;
  await env.bridge.pumpStreams();
  assert.equal(t.kit.filter((k) => k.op === "update" || k.op === "text").length, 2);

  await env.bridge.onMessage(textMsg("om_stop", "/stop"));
  await waitFor(() => env.routes.get("om_s5")?.cardFinal === true);
  assert.equal(existsSync(join(env.paths.stream, "om_s5.jsonl")), false);
  const n = t.kit.length;
  await stream(env, "om_s5", "c");
  env.clock.now += 5000;
  await env.bridge.pumpStreams();
  assert.equal(t.kit.length, n);

  const off = await makeEnv({ config: { ...CFG, streamReplies: false }, ackDelayMs: 60_000 });
  await off.bridge.onMessage(textMsg("om_s6", "hi"));
  await stream(off, "om_s6", "x");
  await off.bridge.pumpStreams();
  assert.equal(off.t.cards().length, 0);

  const classic = await makeEnv({ ackDelayMs: 60_000 });
  await classic.bridge.onMessage(textMsg("om_s7", "hi"));
  await stream(classic, "om_s7", "x");
  await classic.bridge.pumpStreams();
  assert.equal(classic.t.delivered.length, 0);
});

test("流式：不安全的文件名、没有路由的文件被忽略/清理", async () => {
  const env = await makeEnv({ config: CFG, ackDelayMs: 60_000 });
  await mkdir(env.paths.stream, { recursive: true });
  await writeFile(join(env.paths.stream, "om_unknown.jsonl"), '{"text":"x"}\n');
  await writeFile(join(env.paths.stream, "..evil.jsonl"), '{"text":"x"}\n');
  await env.bridge.pumpStreams();
  assert.equal(existsSync(join(env.paths.stream, "om_unknown.jsonl")), false);
  assert.equal(env.t.delivered.length, 0);
});

test("M1 卡片点击的流式回复：处理中卡发到原卡片消息（route.replyTo），不是合成的 card_ id；CardKit 不被关掉", async () => {
  const t = new KitTransport();
  const env = await makeEnv({ config: CFG, ackDelayMs: 60_000, t });
  await env.bridge.onCardAction({ messageId: "om_orig", chatId: "oc_1", operatorOpenId: "ou_owner", eventId: "ev_m1", value: { k: 1 } });
  const id = [...env.routes.entries()].map(([k]) => k).find((k) => k.startsWith("card_"))!;
  assert.ok(id);
  await stream(env, id, "点击后的输出");
  await env.bridge.pumpStreams();
  const replies = t.calls.filter((c) => c.method === "replyCardEntity" || c.method === "replyCard");
  assert.deepEqual(replies.map((c) => c.target), ["om_orig"]);
  assert.ok(env.routes.get(id)?.cardId, "用上了 CardKit 卡片实体");
  assert.ok(!env.logs.some((l) => l.event === "daemon.cardkit_disabled"));
});

test("M1 replyCardEntity 永久失败（如原消息已撤回）只让这一条退回普通卡片，不全局关掉 CardKit；非权限的创建失败同理", async () => {
  const t = new KitTransport();
  const env = await makeEnv({ config: CFG, ackDelayMs: 10, t });
  t.failNext("replyCardEntity", httpError(400, 230011, "message recalled"));
  await env.bridge.onMessage(textMsg("om_r1", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_r1")?.cardMessageId));
  assert.equal(env.routes.get("om_r1")!.cardId, undefined, "这一条退回普通卡片");
  assert.deepEqual(t.calls.filter((c) => c.method === "replyCard").map((c) => c.target), ["om_r1"]);

  t.failNext("createCardEntity", httpError(400, 230099, "bad card"));
  await env.bridge.onMessage(textMsg("om_r2", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_r2")?.cardMessageId));
  assert.equal(env.routes.get("om_r2")!.cardId, undefined);

  await env.bridge.onMessage(textMsg("om_r3", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_r3")?.cardMessageId));
  assert.ok(env.routes.get("om_r3")!.cardId, "下一条消息照常用 CardKit");
  assert.ok(!env.logs.some((l) => l.event === "daemon.cardkit_disabled"));

  t.failNext("createCardEntity", httpError(403, undefined, "forbidden"));
  await env.bridge.onMessage(textMsg("om_r4", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_r4")?.cardMessageId));
  assert.ok(env.logs.some((l) => l.event === "daemon.cardkit_disabled"), "HTTP 403 才算没权限");
});

test("L4 流式推送失败不算已显示：下一轮（过了节流）重推同一段文本", async () => {
  const t = new KitTransport();
  const env = await makeEnv({ config: CFG, ackDelayMs: 10, t });
  await env.bridge.onMessage(textMsg("om_l4", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_l4")?.cardId));
  await stream(env, "om_l4", "最后一段");
  t.failNext("updateCardEntity", httpError(503));
  await env.bridge.pumpStreams();
  assert.ok(env.logs.some((l) => l.event === "daemon.stream_failed"));
  assert.equal(t.kit.filter((k) => k.op === "update").length, 0);
  env.clock.now += 1000;
  await env.bridge.pumpStreams();
  const ups = t.kit.filter((k) => k.op === "update");
  assert.equal(ups.length, 1);
  assert.equal(cardText(ups[0].arg), "最后一段");
});

test("L6 CardKit sequence 按段预留落盘：流式推送不再每次重写 routes.json；重启后仍严格递增", async () => {
  const t = new KitTransport();
  const env = await makeEnv({ config: CFG, ackDelayMs: 10, t });
  await env.bridge.onMessage(textMsg("om_l6", "hi"));
  await waitFor(() => Boolean(env.routes.get("om_l6")?.cardId));
  let writes = 0;
  const origSet = env.routes.set.bind(env.routes);
  env.routes.set = (id, r) => (writes++, origSet(id, r));
  for (let i = 0; i < 10; i++) {
    await stream(env, "om_l6", `段${i}`);
    env.clock.now += 1000;
    await env.bridge.pumpStreams();
  }
  const used = t.kit.filter((k) => k.cardId === "card_1" && k.seq !== undefined).map((k) => k.seq!);
  assert.ok(used.length >= 10);
  assert.ok(writes <= 3, `routes 写入 ${writes} 次`);
  await env.routes.persist();
  // 重启：新 bridge 读同一个 routes.json，接着推的 sequence 必须大于用过的
  const t2 = new KitTransport();
  const env2 = await makeEnv({ config: CFG, ackDelayMs: 60_000, t: t2, root: env.root });
  await stream(env2, "om_l6", "重启后");
  env2.clock.now = env.clock.now + 1000;
  await env2.bridge.pumpStreams();
  const after = t2.kit.filter((k) => k.seq !== undefined).map((k) => k.seq!);
  assert.ok(after.length > 0);
  assert.ok(Math.min(...after) > Math.max(...used));
});
