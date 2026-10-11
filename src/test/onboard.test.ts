/** 扫码接入的纯函数：参数、secrets.env / config.json 合并。不连网。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, mergeSecrets, parseArgs, REQUIRED_ADDONS } from "../onboard.js";

test("onboard 参数解析", () => {
  assert.deepEqual(parseArgs([]), { updatePermissions: false, help: false });
  assert.equal(parseArgs(["--name", "小助手"]).name, "小助手");
  assert.equal(parseArgs(["--name=小 助手"]).name, "小 助手");
  assert.equal(parseArgs(["--update-permissions"]).updatePermissions, true);
  assert.throws(() => parseArgs(["--bogus"]));
});

test("secrets.env 合并：替换新旧键名、保留其他行、末尾换行", () => {
  const out = mergeSecrets("# 注释\nAPP_ID=old\nHTTPS_PROXY=http://p:1\nFEISHU_APP_SECRET=x\n\n", "cli_new", "sec");
  assert.equal(out, "# 注释\nHTTPS_PROXY=http://p:1\nFEISHU_APP_ID=cli_new\nFEISHU_APP_SECRET=sec\n");
  assert.match(mergeSecrets("", "cli_a", "b"), /^# .*\nFEISHU_APP_ID=cli_a\nFEISHU_APP_SECRET=b\n$/);
});

test("config 合并：扫码人进白名单并做主人，去掉示例占位符；Lark 设 domain；其他键不动", () => {
  const out = mergeConfig({ allowedOpenIds: ["ou_xxx"], ownerOpenId: "ou_xxx", replyTimeoutMin: 20 }, "ou_me", "feishu");
  assert.deepEqual(out, { allowedOpenIds: ["ou_me"], ownerOpenId: "ou_me", replyTimeoutMin: 20 });
  const keep = mergeConfig({ allowedOpenIds: ["ou_a"], ownerOpenId: "ou_a" }, "ou_me", "lark");
  assert.deepEqual(keep, { allowedOpenIds: ["ou_me", "ou_a"], ownerOpenId: "ou_a", domain: "lark" });
  assert.deepEqual(mergeConfig({ allowedOpenIds: ["ou_me"] }, "ou_me", undefined).allowedOpenIds, ["ou_me"]);
});

test("预填的权限包含流式卡片与卡片回调", () => {
  assert.ok(REQUIRED_ADDONS.scopes.tenant.includes("cardkit:card:write"));
  assert.ok(REQUIRED_ADDONS.scopes.tenant.includes("im:message:update"));
  assert.deepEqual(REQUIRED_ADDONS.events.items.tenant, ["im.message.receive_v1"]);
  assert.deepEqual(REQUIRED_ADDONS.callbacks.items, ["card.action.trigger"]);
});
