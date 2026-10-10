/**
 * 进程级测试：真实 dist/daemon.js + 假飞书 SDK（test/fixtures/fake-lark-sdk）。
 * 覆盖：单实例锁、kill -9 后陈旧锁回收 + inflight 崩溃恢复、keepalive 身份核实与拉起、
 * transport 的 uuid / @主人 / 业务错误码 / 视频类型 / 事件 3 秒应答。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, symlink, rename } from "node:fs/promises";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor, sleep, ls } from "./helpers.js";
import { parseProcStat, readStartTime, isSameProcessAlive, parseIdentity } from "../proc.js";
import { acquireInstanceLock } from "../lock.js";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const HAS_PROC = existsSync("/proc/self/stat");

interface Root {
  root: string;
  fake: string;
  calls(method?: string): any[];
  event(type: string, data: unknown): Promise<void>;
  msg(id: string, text: string, extra?: Record<string, unknown>): Promise<void>;
  start(extraEnv?: Record<string, string>): ChildProcess;
  procs: ChildProcess[];
}

let evSeq = 0;
async function makeRoot(cfg: Record<string, unknown> = { allowedOpenIds: ["ou_owner"], ackDelaySec: 0 }): Promise<Root> {
  const root = await mkdtemp(join(tmpdir(), "mfb-proc-"));
  const fake = join(root, "fake");
  await mkdir(join(fake, "events"), { recursive: true });
  await cp(join(REPO, "dist"), join(root, "dist"), { recursive: true });
  await cp(join(REPO, "keepalive.sh"), join(root, "keepalive.sh"));
  await cp(join(REPO, "package.json"), join(root, "package.json"));
  await mkdir(join(root, "node_modules", "@larksuiteoapi"), { recursive: true });
  await cp(join(REPO, "test", "fixtures", "fake-lark-sdk"), join(root, "node_modules", "@larksuiteoapi", "node-sdk"), { recursive: true });
  // 真实的代理依赖（https-proxy-agent 及其依赖）
  for (const m of ["https-proxy-agent", "agent-base", "debug", "ms"]) {
    await cp(join(REPO, "node_modules", m), join(root, "node_modules", m), { recursive: true });
  }
  await writeFile(join(root, "secrets.env"), "FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=s3cr3t\n", { mode: 0o600 });
  await writeFile(join(root, "config.json"), JSON.stringify(cfg));
  const procs: ChildProcess[] = [];
  const r: Root = {
    root,
    fake,
    procs,
    calls(method?: string) {
      try {
        const L = readFileSync(join(fake, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((x) => JSON.parse(x));
        return method ? L.filter((c: any) => c.method === method) : L;
      } catch {
        return [];
      }
    },
    async event(type, data) {
      const p = join(fake, "events", `${String(++evSeq).padStart(6, "0")}`);
      await writeFile(p + ".tmp", JSON.stringify({ type, data }));
      await rename(p + ".tmp", p + ".json");
    },
    async msg(id, text, extra = {}) {
      await r.event("im.message.receive_v1", {
        sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: id, chat_id: "oc_1", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }), ...extra },
      });
    },
    start(extraEnv = {}) {
      const p = spawn(process.execPath, [join(root, "dist", "daemon.js")], {
        cwd: root,
        env: { ...process.env, FAKE_DIR: fake, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
      p.stdout!.on("data", (b) => appendFileSync(join(root, "daemon.log"), b));
      p.stderr!.on("data", (b) => appendFileSync(join(root, "daemon.log"), b));
      procs.push(p);
      return p;
    },
  };
  return r;
}

function cleanup(r: Root) {
  for (const p of r.procs) if (p.exitCode === null) p.kill("SIGKILL");
}

const exited = (p: ChildProcess) => new Promise<number | null>((res) => (p.exitCode !== null ? res(p.exitCode) : p.once("exit", (c) => res(c))));
const ready = (r: Root, p: ChildProcess) => waitFor(() => r.calls("wsStart").some((c) => c.pid === p.pid) && existsSync(join(r.root, "daemon.pid")), 8000);

test("proc: /proc/<pid>/stat 解析——comm 含空格与 ')' 时截到最后一个 ')'", () => {
  const line = "1234 (a b) c) S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100";
  const st = parseProcStat(line);
  assert.equal(st?.pid, 1234);
  assert.equal(st?.comm, "a b) c");
  assert.equal(st?.starttime, "987654");
  assert.equal(parseIdentity("12 34 abcdefgh")?.token, "abcdefgh");
  assert.equal(parseIdentity("1 34 abcdefgh"), null);
});

test("proc: isSameProcessAlive 要求 starttime 一致（防 pid 复用）", { skip: !HAS_PROC }, () => {
  const st = readStartTime(process.pid)!;
  assert.ok(st);
  assert.equal(isSameProcessAlive({ pid: process.pid, starttime: st, token: "tok12345" }), true);
  assert.equal(isSameProcessAlive({ pid: process.pid, starttime: String(BigInt(st) + 1n), token: "tok12345" }), false);
  assert.equal(isSameProcessAlive({ pid: 999999, starttime: st, token: "tok12345" }), false);
});

test("lock: O_EXCL 获取；持有者存活则失败；死进程的陈旧锁被回收", { skip: !HAS_PROC }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "mfb-lock-"));
  const path = join(dir, "daemon.lock");
  const me = { pid: process.pid, starttime: readStartTime(process.pid)!, token: "aaaaaaaa1" };
  assert.deepEqual(acquireInstanceLock(path, me), { ok: true, reclaimed: false });
  const other = { pid: process.pid, starttime: me.starttime, token: "bbbbbbbb2" };
  assert.equal(acquireInstanceLock(path, other).ok, false, "持有者（同 pid+starttime）存活");
  await writeFile(path, `999999 123 deadbeef0\n`);
  assert.deepEqual(acquireInstanceLock(path, other), { ok: true, reclaimed: true });
});

test("e2e: 第二个 daemon 拒绝启动；kill -9 后陈旧锁被回收，inflight 里的回复续发且不重复", { skip: !HAS_PROC, timeout: 60_000 }, async (t) => {
  const r = await makeRoot();
  t.after(() => cleanup(r));
  const a = r.start();
  await ready(r, a);
  const b = r.start();
  assert.equal(await exited(b), 1);
  assert.match(await readFile(join(r.root, "daemon.log"), "utf8"), /已有 daemon 持有锁/);

  // 正常收发
  await r.msg("om_e1", "你好");
  await waitFor(() => existsSync(join(r.root, "inbox", "om_e1.json")));
  await writeFile(join(r.root, "outbox", "om_e1.json"), JSON.stringify({ messageId: "om_e1", text: "回复1 @主人" }));
  await waitFor(() => existsSync(join(r.root, "sent", "om_e1.json")));
  const rep = r.calls("reply").find((c) => c.args.path.message_id === "om_e1");
  assert.equal(rep.args.data.msg_type, "interactive", "默认卡片样式");
  const repCard = JSON.parse(rep.args.data.content);
  assert.equal(repCard.schema, "2.0");
  assert.equal(repCard.header.template, "green");
  assert.match(repCard.body.elements[0].content, /回复1 <at id=ou_owner><\/at>/);
  assert.ok(typeof rep.args.data.uuid === "string" && rep.args.data.uuid.length <= 50);

  // 模拟：发送途中 kill -9（文件留在 inflight，进度记了 text:0）
  a.kill("SIGKILL");
  await exited(a);
  await mkdir(join(r.root, "inflight"), { recursive: true });
  await writeFile(join(r.root, "inflight", "om_e2.json"), JSON.stringify({ messageId: "om_e2", text: "只剩这段\n\n".repeat(1) }));
  await writeFile(join(r.root, "progress", "om_e2.json"), JSON.stringify({ done: [], failedParts: [], attempts: 0, partFailures: {} }));
  const c = r.start();
  await ready(r, c);
  await waitFor(() => existsSync(join(r.root, "sent", "om_e2.json")), 8000);
  assert.equal(r.calls("reply").filter((x) => x.args.path.message_id === "om_e2").length, 1);
  assert.match(await readFile(join(r.root, "debug.log"), "utf8").catch(() => ""), /lock_reclaimed|inflight_recovered/);
  c.kill("SIGTERM");
  assert.equal(await exited(c), 0);
  assert.ok(!existsSync(join(r.root, "daemon.lock")), "正常退出释放锁");
});

test("e2e: 飞书业务错误码（HTTP 200 + code≠0）不再被当作成功；事件处理不阻塞应答", { skip: !HAS_PROC, timeout: 30_000 }, async (t) => {
  const r = await makeRoot();
  t.after(() => cleanup(r));
  await writeFile(join(r.fake, "fail.json"), JSON.stringify({ replyBizCode: 230002 }));
  const a = r.start();
  await ready(r, a);
  await writeFile(join(r.root, "outbox", "om_b1.json"), JSON.stringify({ messageId: "om_b1", text: "x" }));
  await waitFor(() => existsSync(join(r.root, "failed", "om_b1.json")), 8000);
  const why = JSON.parse(await readFile(join(r.root, "failed", "om_b1.reason.json"), "utf8"));
  assert.match(why.reason, /230002/);
  await r.msg("om_b2", "hi");
  await waitFor(() => r.calls("eventResult").length >= 1);
  const res = r.calls("eventResult")[0];
  const recv = r.calls("event")[0];
  assert.ok(res.t - recv.t < 1000, "事件处理器立即返回（< 3 秒应答要求）");
});

test("e2e: 视频与文件类型——.mp4 走 media，.mov 按普通文件；ROOT 外 /etc/passwd 被拒", { skip: !HAS_PROC, timeout: 30_000 }, async (t) => {
  const r = await makeRoot();
  t.after(() => cleanup(r));
  const a = r.start();
  await ready(r, a);
  await mkdir(join(r.root, "outgoing"), { recursive: true });
  await writeFile(join(r.root, "outgoing", "v.mp4"), "mp4data");
  await writeFile(join(r.root, "outgoing", "v.mov"), "movdata");
  for (const [id, f] of [["om_v1", "v.mp4"], ["om_v2", "v.mov"]]) {
    await writeFile(join(r.root, "outbox", `${id}.json`), JSON.stringify({ messageId: id, text: "", file: join(r.root, "outgoing", f) }));
  }
  await writeFile(join(r.root, "outbox", "om_v3.json"), JSON.stringify({ messageId: "om_v3", text: "", file: "/etc/passwd" }));
  await waitFor(async () => (await ls(join(r.root, "sent"))).length === 2 && (await ls(join(r.root, "failed"))).length === 2, 8000);
  const ups = r.calls("fileUpload").map((c) => c.args.file_type).sort();
  assert.deepEqual(ups, ["mp4", "stream"]);
  const types = r.calls("reply").map((c) => [c.args.path.message_id, c.args.data.msg_type]);
  assert.deepEqual(types.filter(([id]) => id !== "om_v3").sort(), [["om_v1", "media"], ["om_v2", "file"]]);
  assert.ok(types.some(([id, ty]) => id === "om_v3" && ty === "interactive"), "拒绝后用红色卡片通知用户");
});

test("e2e: keepalive——ROOT 叫 muse-feishu-bridge 也能识别自己（原版 pgrep 模式写死 muse-feishu/）；不健康时拉起，健康不重拉", { skip: !HAS_PROC || !existsSync("/usr/bin/setsid"), timeout: 90_000 }, async (t) => {
  const base = await makeRoot();
  t.after(() => cleanup(base));
  const parent = await mkdtemp(join(tmpdir(), "mfb-ka-"));
  const root = join(parent, "muse-feishu-bridge");
  await symlink(base.root, root); // 经符号链接的 ROOT 也要识别
  const env = { ...process.env, FAKE_DIR: base.fake, MUSE_FEISHU_WAIT_SEC: "20", MUSE_FEISHU_START_GRACE_SEC: "5" };
  const st0 = spawnSync("bash", [join(root, "keepalive.sh"), "--status"], { env, encoding: "utf8" });
  assert.equal(st0.status, 1, "没有 daemon → 不健康");
  const ka = spawnSync("bash", [join(root, "keepalive.sh")], { env, encoding: "utf8", timeout: 40_000 });
  assert.equal(ka.status, 0, await readFile(join(base.root, "daemon.log"), "utf8").catch(() => ""));
  const pid1 = Number((await readFile(join(base.root, "daemon.pid"), "utf8")).split(" ")[0]);
  const st1 = spawnSync("bash", [join(root, "keepalive.sh"), "--status"], { env, encoding: "utf8" });
  assert.equal(st1.status, 0, "daemon 在跑 → 健康");
  const ka2 = spawnSync("bash", [join(root, "keepalive.sh")], { env, encoding: "utf8", timeout: 40_000 });
  assert.equal(ka2.status, 0);
  const pid2 = Number((await readFile(join(base.root, "daemon.pid"), "utf8")).split(" ")[0]);
  assert.equal(pid2, pid1, "健康时不重拉");
  process.kill(pid1, "SIGTERM");
  await waitFor(() => !existsSync(`/proc/${pid1}`), 5000);
  await sleep(100);
});

test("e2e: keepalive --install-cron 幂等，不动用户其他条目；--uninstall-cron 只删自己的", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mfb-cron-"));
  const tab = join(dir, "tab");
  await writeFile(tab, "0 3 * * * /usr/bin/backup.sh\n");
  await writeFile(join(dir, "crontab"), `#!/bin/bash\nif [ "$1" = "-l" ]; then cat "${tab}"; else cat > "${tab}"; fi\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const ka = join(REPO, "keepalive.sh");
  for (let i = 0; i < 2; i++) assert.equal(spawnSync("bash", [ka, "--install-cron"], { env }).status, 0);
  const lines = readFileSync(tab, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("backup.sh"));
  assert.ok(lines.some((l) => l.startsWith("*/5 * * * * ") && l.includes("keepalive.sh")));
  assert.ok(lines.some((l) => l.startsWith("@reboot ")));
  assert.equal(spawnSync("bash", [ka, "--uninstall-cron"], { env }).status, 0);
  assert.deepEqual(readFileSync(tab, "utf8").trim().split("\n"), ["0 3 * * * /usr/bin/backup.sh"]);
});
