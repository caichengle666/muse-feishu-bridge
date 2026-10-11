/** hooks/feishu-inbox-watch.sh：上下文维护（/clear、压缩请求、认领顺序）。需要 bash + python3 + jq，缺了就跳过。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "feishu-inbox-watch.sh");
const has = (cmd: string) => spawnSync("bash", ["-c", `command -v ${cmd}`]).status === 0;
const SKIP = !(has("python3") && has("jq"));

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "mfb-hook-"));
  const bridge = join(home, "workspace", "muse-feishu-bridge");
  for (const d of ["inbox", "sent", "failed", "expired", "stop"]) await mkdir(join(bridge, d), { recursive: true });
  const runtime = join(home, "runtime.sh");
  await writeFile(runtime, 'silent() { echo "SILENT $1"; exit 0; }\nwake() { echo "WAKE $1"; echo "$2"; exit 0; }\n');
  // 心跳正常，免得空轮询走健康告警
  const state = join(home, "hooks", "state");
  const run = async () => {
    await writeFile(join(bridge, "heartbeat.json"), JSON.stringify({ ts: Date.now(), connected: true }));
    const r = spawnSync("bash", [HOOK], { env: { ...process.env, HOME: home, HATCH_HOOK_RUNTIME: runtime }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const inbox = (id: string, text: string, ts: string) =>
    writeFile(join(bridge, "inbox", `${id}.json`), JSON.stringify({ messageId: id, chatId: "oc_1", text, ts }));
  const sent = (id: string, text: string) => writeFile(join(bridge, "sent", `${id}.json`), JSON.stringify({ messageId: id, text }));
  const ctxFile = join(state, "feishu-ctx-oc_1.json");
  const ctx = async () => JSON.parse(await readFile(ctxFile, "utf8"));
  const pending = async () => JSON.parse(await readFile(join(state, "feishu-pending.json"), "utf8"));
  return { home, bridge, state, run, inbox, sent, ctx, ctxFile, pending };
}

test("M2 /clear 之后迟到的旧压缩请求被丢弃：不删新话题的轮次、不带回旧摘要；seq 接着编", { skip: SKIP }, async () => {
  const h = await setup();
  await mkdir(h.state, { recursive: true });
  await writeFile(h.ctxFile, JSON.stringify({ chatId: "oc_1", summary: "", next_seq: 4, turns: [1, 2, 3].map((seq) => ({ seq, user: `old${seq}`, assistant: "a" })) }));
  await h.inbox("om_c", "/clear", "2026-10-11T11:00:00.000Z");
  await h.run();
  let c = await h.ctx();
  assert.deepEqual([c.turns.length, c.next_seq, c.clear_floor], [0, 4, 4]);

  await h.inbox("om_n", "new topic", "2026-10-11T11:01:00.000Z");
  await h.run();
  await h.sent("om_n", "new answer");
  await h.run(); // 收割
  c = await h.ctx();
  assert.deepEqual(c.turns.map((t: { seq: number; user: string }) => [t.seq, t.user]), [[4, "new topic"]]);

  // 清空前就在跑的 worker 迟到的压缩结果
  await writeFile(join(h.state, "feishu-ctx-oc_1.summary.json"), JSON.stringify({ summary: "OLD TOPIC SUMMARY", upto_seq: 3 }));
  await h.run();
  c = await h.ctx();
  assert.equal(c.summary, "");
  assert.equal(c.turns.length, 1, "新话题的轮次还在");

  // 新话题自己的压缩请求照常生效
  await writeFile(join(h.state, "feishu-ctx-oc_1.summary.json"), JSON.stringify({ summary: "NEW SUMMARY", upto_seq: 4 }));
  await h.run();
  c = await h.ctx();
  assert.deepEqual([c.summary, c.turns.length], ["NEW SUMMARY", 0]);
});

test("M2 worker 请求的换话题（.clear.json）同样保留 seq 并挡住旧压缩请求", { skip: SKIP }, async () => {
  const h = await setup();
  await mkdir(h.state, { recursive: true });
  await writeFile(h.ctxFile, JSON.stringify({ chatId: "oc_1", summary: "s", next_seq: 6, turns: [{ seq: 5, user: "u", assistant: "a" }] }));
  await writeFile(join(h.state, "feishu-ctx-oc_1.clear.json"), JSON.stringify({ messageId: "om_gone" }));
  await h.run();
  const c = await h.ctx();
  assert.deepEqual([c.turns.length, c.summary, c.next_seq, c.clear_floor], [0, "", 6, 6]);
});

test("L1 同一轮认领到『较早的消息 + 之后的 /clear』：按消息时间处理，较早那条不进新历史（与文件名顺序无关）", { skip: SKIP }, async () => {
  const h = await setup();
  await h.inbox("om_z", "hello old topic", "2026-10-11T11:01:00.000Z");
  await h.inbox("om_a", "/clear", "2026-10-11T11:01:01.000Z");
  await h.run();
  const p = await h.pending();
  assert.equal(p.om_z.skip, true);
  await h.sent("om_z", "reply");
  await h.run();
  assert.deepEqual((await h.ctx()).turns, []);
});

test("L2 过期认领回收：.claimed 已被 /stop 移走就不会凭空建一个空文件", { skip: SKIP }, async () => {
  const h = await setup();
  // 空的 .claimed（模拟 touch 抢在 rename 之后建出来的）不算认领
  const f = join(h.bridge, "inbox", "om_s.json.claimed");
  await writeFile(f, "");
  spawnSync("touch", ["-d", "2 hours ago", f]);
  const out = await h.run();
  assert.doesNotMatch(out, /om_s/);
});

test("L7 认领有效期跟着 config.json 的 replyTimeoutMin：没超过它的认领不会被重复唤醒", { skip: SKIP }, async () => {
  const h = await setup();
  await writeFile(join(h.bridge, "config.json"), JSON.stringify({ replyTimeoutMin: 60 }));
  const f = join(h.bridge, "inbox", "om_l.json.claimed");
  await writeFile(f, JSON.stringify({ messageId: "om_l", chatId: "oc_1", text: "x", ts: "2026-10-11T11:00:00.000Z" }));
  spawnSync("touch", ["-d", "40 minutes ago", f]); // 超过旧的固定 25 分钟，但没超过 60+5
  assert.doesNotMatch(await h.run(), /om_l/);
  spawnSync("touch", ["-d", "70 minutes ago", f]);
  assert.match(await h.run(), /om_l/);
  assert.ok(existsSync(f));
});
