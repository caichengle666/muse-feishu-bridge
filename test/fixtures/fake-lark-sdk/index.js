// 测试用假飞书 SDK（仅供 src/test/process.test.ts 与联调脚本使用，不会被生产代码引用）
// 假飞书 SDK：调用记录到 $FAKE_DIR/calls.jsonl；事件从 $FAKE_DIR/events/*.json 注入；
// 失败注入：$FAKE_DIR/fail.json = {"reply":[{"times":2,"msg":"..."}], "replyDelayMs":0}
const fs = require("fs"), path = require("path");
const DIR = process.env.FAKE_DIR;
const rec = (method, args) => fs.appendFileSync(path.join(DIR, "calls.jsonl"), JSON.stringify({ t: Date.now(), pid: process.pid, method, args }) + "\n");
function failCfg() { try { return JSON.parse(fs.readFileSync(path.join(DIR, "fail.json"), "utf8")); } catch { return {}; } }
const counts = {};
function maybeFail(method) {
  const cfg = failCfg();
  counts[method] = (counts[method] || 0) + 1;
  if (cfg[method + "FailFrom"] && counts[method] >= cfg[method + "FailFrom"]) { const e = new Error(cfg[method + "FailMsg"] || "Request failed with status code 400"); e.response = { status: 400 }; throw e; }
  const q = cfg[method];
  if (Array.isArray(q) && q.length) {
    const head = q[0];
    head.times = (head.times ?? 1) - 1;
    if (head.times <= 0) q.shift();
    fs.writeFileSync(path.join(DIR, "fail.json"), JSON.stringify(cfg));
    const e = new Error(head.msg || "fake failure");
    if (head.status) e.response = { status: head.status, data: head.data };
    if (head.code) e.code = head.code;
    throw e;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
async function call(method, args) {
  const d = failCfg()[method + "DelayMs"] || 0;
  if (d) await sleep(d);
  rec(method, args);
  maybeFail(method);
  const biz = failCfg()[method + "BizCode"];
  if (biz) return { code: biz, msg: "fake biz error" };
  return { code: 0, data: { message_id: "om_bot_" + (++seq), image_key: "img_" + seq, file_key: "file_" + seq } };
}
class Client {
  constructor(o) { this.o = o; this.httpInstance = { defaults: {} };
    this.im = {
      message: { reply: (a) => call("reply", a), create: (a) => call("create", a) },
      messageReaction: { create: (a) => call("reaction", a) },
      v1: {
        chat: { get: async () => ({ data: { chat_mode: "group" } }) },
        image: { create: (a) => call("imageUpload", { size: a.data.image.length }), get: async () => { throw new Error("nope"); } },
        file: { create: (a) => call("fileUpload", { file_type: a.data.file_type, file_name: a.data.file_name, size: a.data.file.length }) },
        message: { patch: (a) => call("patch", a) },
        messageResource: { get: async (a) => { rec("resourceGet", a); const b = Buffer.from(failCfg().resourceBytes || "\x89PNG\r\n\x1a\n0000fakeimg"); return { headers: { "content-type": "image/png" }, getReadableStream: () => require("stream").Readable.from([b]) }; } },
      },
    };
  }
  async request(r) { if (r.url.includes("bot/v3/info")) return { bot: { open_id: "ou_bot" } }; return {}; }
}
class EventDispatcher { constructor() { this.h = {}; } register(m) { Object.assign(this.h, m); return this; } }
class WSClient {
  constructor(o) { this.o = o; }
  async start({ eventDispatcher }) {
    rec("wsStart", {});
    this.d = eventDispatcher;
    setTimeout(() => this.o.onReady && this.o.onReady(), 10);
    const evDir = path.join(DIR, "events");
    fs.mkdirSync(evDir, { recursive: true });
    this.timer = setInterval(async () => {
      for (const f of fs.readdirSync(evDir).sort()) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(evDir, f);
        const claimed = p + "." + process.pid;
        try { fs.renameSync(p, claimed); } catch { continue; }
        const ev = JSON.parse(fs.readFileSync(claimed, "utf8"));
        fs.unlinkSync(claimed);
        const h = this.d.h[ev.type];
        rec("event", { type: ev.type });
        if (h) { try { const r = await h(ev.data); rec("eventResult", { type: ev.type, r: r === undefined ? null : r }); } catch (e) { rec("eventError", { m: String(e) }); } }
      }
    }, 20);
  }
  close() { clearInterval(this.timer); }
}
exports.Client = Client; exports.EventDispatcher = EventDispatcher; exports.WSClient = WSClient;
exports.CardActionHandler = class {}; exports.adaptDefault = () => () => {};
exports.Domain = { Feishu: "feishu", Lark: "lark" }; exports.AppType = { SelfBuild: 0 }; exports.LoggerLevel = { error: 0 };
