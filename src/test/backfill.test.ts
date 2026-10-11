/** 断线补拉：历史消息转事件、会话登记、分页拉取并走实时处理路径。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuTransport, historyItemToEvent } from "../transport.js";
import { ChatRegistry } from "../state.js";
import type { FeishuMessage } from "../types.js";

const item = (id: string, ts: number, extra: Record<string, unknown> = {}) => ({
  message_id: id,
  chat_id: "oc_1",
  msg_type: "text",
  create_time: String(ts),
  sender: { id: "ou_user", id_type: "open_id", sender_type: "user" },
  body: { content: JSON.stringify({ text: id }) },
  ...extra,
});

test("历史消息转成 receive_v1 事件形状；撤回的丢弃", () => {
  const ev = historyItemToEvent(
    item("om_1", 1000, { mentions: [{ key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "Bot" }] }),
    "group",
  )!;
  assert.equal(ev.message.message_id, "om_1");
  assert.equal(ev.message.chat_type, "group");
  assert.equal(ev.message.message_type, "text");
  assert.deepEqual(ev.sender.sender_id, { open_id: "ou_user" });
  assert.deepEqual(ev.message.mentions, [{ key: "@_user_1", name: "Bot", id: { open_id: "ou_bot" } }]);
  const app = historyItemToEvent(item("om_2", 1000, { sender: { id: "cli_x", id_type: "app_id", sender_type: "app" } }), "p2p")!;
  assert.deepEqual(app.sender.sender_id, { app_id: "cli_x" });
  assert.equal(historyItemToEvent(item("om_3", 1000, { deleted: true }), "p2p"), undefined);
});

test("会话登记：按最近活跃排序、过滤过期、落盘可恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chats-"));
  const path = join(dir, "chats.json");
  let now = 1_000_000;
  const reg = new ChatRegistry(path, () => now);
  reg.touch("oc_old", "group");
  now += 10 * 60_000;
  reg.touch("oc_new", "p2p");
  await reg.persist();
  assert.deepEqual(reg.recent(60 * 60_000, 10).map((c) => c.chatId), ["oc_new", "oc_old"]);
  assert.deepEqual(reg.recent(5 * 60_000, 10).map((c) => c.chatId), ["oc_new"]);
  const again = new ChatRegistry(path, () => now);
  again.loadSync();
  assert.deepEqual(again.recent(60 * 60_000, 1), [{ chatId: "oc_new", chatType: "p2p" }]);
  assert.ok(JSON.parse(await readFile(path, "utf8")).chats.oc_old);
});

test("backfillChat：分页拉取、跳过早于起点的和自己发的，交给 onMessage", async () => {
  const got: FeishuMessage[] = [];
  const t = new FeishuTransport(
    { appId: "cli_me", appSecret: "s", domain: "feishu", groupPolicy: "mention" },
    async (m) => { got.push(m); },
    async () => undefined,
  );
  const calls: any[] = [];
  (t as any).sdkClient = {
    im: {
      v1: {
        message: {
          list: async (req: any) => {
            calls.push(req.params);
            if (!req.params.page_token) {
              return { code: 0, data: { has_more: true, page_token: "p2", items: [item("om_early", 4000), item("om_a", 6000)] } };
            }
            return {
              code: 0,
              data: {
                has_more: false,
                items: [item("om_self", 7000, { sender: { id: "cli_me", id_type: "app_id", sender_type: "app" } }), item("om_b", 8000)],
              },
            };
          },
        },
      },
    },
  };
  const n = await t.backfillChat("oc_1", "p2p", 5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].start_time, "5");
  assert.equal(calls[0].container_id, "oc_1");
  assert.equal(n, 3); // om_a、om_self、om_b 进入处理；om_self 在处理时被丢弃
  assert.deepEqual(got.map((m) => m.messageId), ["om_a", "om_b"]);
  assert.equal(got[0].senderOpenId, "ou_user");
  assert.equal(got[0].chatType, "p2p");
});

test("backfillChat：接口报错（如缺权限）抛出 code", async () => {
  const t = new FeishuTransport(
    { appId: "cli_me", appSecret: "s", domain: "feishu", groupPolicy: "mention" },
    async () => undefined,
    async () => undefined,
  );
  (t as any).sdkClient = { im: { v1: { message: { list: async () => ({ code: 230027, msg: "Lack of necessary permissions" }) } } } };
  await assert.rejects(() => t.backfillChat("oc_g", "group", 0), /230027/);
});
