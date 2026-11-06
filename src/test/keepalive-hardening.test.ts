/** 保活加固回归测试：数值参数校验、连续失败退避、"半核实"假死进程、日志轮转、cron 输出、hook 兜底拉起。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(import.meta.url), "..", "..", "..");
const KA = join(REPO, "keepalive.sh");
const HOOK = join(REPO, "hooks", "feishu-inbox-watch.sh");
const HOOK_JSON = join(REPO, "hooks", "feishu-inbox-watch.json");
const P = "MUSE_FEISHU";
const HAS_PROC = existsSync("/proc/self/stat");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of Object.keys(e)) if (k.startsWith(P + "_")) delete e[k];
  delete e.NODE_BIN;
  return { ...e, NODE_BIN: process.execPath, ...extra };
}

function sourced(script: string, env: Record<string, string>) {
  return spawnSync("bash", ["-c", `source ${JSON.stringify(KA)}; ${script}`], { env: baseEnv(env), encoding: "utf8" });
}

/** 假 daemon：带 stay 参数时常驻，否则立即退出（keepalive 拉起的那份会马上退出，不留进程） */
async function fakeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ka-hard-"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "daemon.js"), 'if (process.argv[2] === "stay") setInterval(() => {}, 1000);\n');
  return root;
}

test("数值环境变量写错（90s / abc / -1）时改用默认值，不会把健康的 daemon 判成不健康", () => {
  const r = sourced('echo "$GRACE $START_GRACE $STALE $WAIT_SEC $BACKOFF_MAX $LOG_MAX_MB"; echo "BAD=$BAD_NUM"', {
    [`${P}_GRACE_SEC`]: "abc",
    [`${P}_STALE_SEC`]: "90s",
    [`${P}_WAIT_SEC`]: "-1",
    [`${P}_BACKOFF_MAX_SEC`]: "0",
    [`${P}_LOG_MAX_MB`]: "",
  });
  const [vals, bad] = r.stdout.trim().split("\n");
  assert.equal(vals, "90 90 90 45 1800 10");
  assert.match(bad, /_GRACE_SEC='abc'→90/);
  assert.match(bad, /_STALE_SEC='90s'→90/);
  // 合法值照用；START_GRACE 默认跟随 GRACE
  const ok = sourced('echo "$GRACE $START_GRACE $STALE BAD=$BAD_NUM"', { [`${P}_GRACE_SEC`]: "30", [`${P}_STALE_SEC`]: "120" });
  assert.equal(ok.stdout.trim(), "30 30 120 BAD=");
  // --status 在 stderr 提示
  const st = spawnSync("bash", [KA, "--status"], { env: baseEnv({ [`${P}_ROOT`]: tmpdir(), [`${P}_STALE_SEC`]: "90s" }), encoding: "utf8" });
  assert.match(st.stderr, /不是合法整数/);
});

test("退避：120→240→480 秒，封顶 BACKOFF_MAX；清除后不再退避", async () => {
  const root = await fakeRoot();
  const r = sourced(
    'for i in 1 2 3 4; do backoff_fail; echo "$BO_FAILS $BO_DELAY"; done; backoff_active && echo active; backoff_clear; backoff_active || echo cleared',
    { [`${P}_ROOT`]: root, [`${P}_BACKOFF_MAX_SEC`]: "400" },
  );
  assert.deepEqual(r.stdout.trim().split("\n"), ["1 120", "2 240", "3 400", "4 400", "active", "cleared"]);
});

test("退避期间不拉起；--force 忽略退避立即重试，失败后次数 +1", async () => {
  const root = await fakeRoot();
  const now = Math.floor(Date.now() / 1000);
  await writeFile(join(root, ".keepalive-backoff"), `3 ${now + 1000}\n`);
  const env = baseEnv({ [`${P}_ROOT`]: root, [`${P}_WAIT_SEC`]: "1" });
  let r = spawnSync("bash", [KA], { env, encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const log0 = existsSync(join(root, "daemon.log")) ? await readFile(join(root, "daemon.log"), "utf8") : "";
  assert.ok(!log0.includes("拉起…"), log0);
  r = spawnSync("bash", [KA, "--force"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 1, r.stderr);
  const log1 = await readFile(join(root, "daemon.log"), "utf8");
  assert.ok(log1.includes("拉起…"), log1);
  assert.match(log1, /连续第 4 次/);
  assert.match(await readFile(join(root, ".keepalive-backoff"), "utf8"), /^4 \d+/);
});

async function stayDaemon(root: string) {
  const child = spawn(process.execPath, [join(root, "dist", "daemon.js"), "stay"], { cwd: root, stdio: "ignore" });
  await sleep(300);
  const st = sourced(`proc_starttime ${child.pid}`, {}).stdout.trim();
  assert.match(st, /^\d+$/);
  await writeFile(join(root, "daemon.pid"), `${child.pid} ${st} tokABCDEF123456\n`);
  return child;
}

test("pid + starttime + 脚本都对上、但心跳文件缺失且超时的假死进程：过了启动宽限才杀，宽限内不杀", { skip: !HAS_PROC, timeout: 60_000 }, async (t) => {
  const root = await fakeRoot();
  const child = await stayDaemon(root);
  let exited = false;
  child.on("exit", () => { exited = true; });
  t.after(() => { if (!exited) child.kill("SIGKILL"); });
  // 宽限内：不杀
  let r = spawnSync("bash", [KA], { env: baseEnv({ [`${P}_ROOT`]: root, [`${P}_START_GRACE_SEC`]: "600", [`${P}_WAIT_SEC`]: "1" }), encoding: "utf8", timeout: 20_000 });
  await sleep(200);
  assert.equal(exited, false, r.stderr);
  assert.match(await readFile(join(root, "daemon.log"), "utf8"), /心跳暂未核实/);
  // 宽限/停滞允许 0；前导 0 按十进制
  assert.equal(sourced('echo "$GRACE $START_GRACE $STALE BAD=$BAD_NUM"', { [`${P}_GRACE_SEC`]: "0", [`${P}_STALE_SEC`]: "090" }).stdout.trim(), "0 0 90 BAD=");
  // 过了宽限、心跳也超时：杀掉重拉（上一轮拉起的假 daemon 立即退出、记了退避，这里用 --force）
  await sleep(1200);
  r = spawnSync("bash", [KA, "--force"], { env: baseEnv({ [`${P}_ROOT`]: root, [`${P}_START_GRACE_SEC`]: "1", [`${P}_STALE_SEC`]: "1", [`${P}_WAIT_SEC`]: "1" }), encoding: "utf8", timeout: 30_000 });
  for (let i = 0; i < 30 && !exited; i++) await sleep(100);
  assert.equal(exited, true, "假死进程应被杀掉");
  const log = await readFile(join(root, "daemon.log"), "utf8");
  assert.match(log, /心跳写不出来的假死/);
  assert.ok(log.includes("拉起…"));
});

test("pid 被复用（starttime 不符）时仍然不杀", { skip: !HAS_PROC, timeout: 30_000 }, async (t) => {
  const root = await fakeRoot();
  const child = await stayDaemon(root);
  t.after(() => child.kill("SIGKILL"));
  await writeFile(join(root, "daemon.pid"), `${child.pid} 1 tokABCDEF123456\n`);
  await sleep(1100);
  spawnSync("bash", [KA], { env: baseEnv({ [`${P}_ROOT`]: root, [`${P}_START_GRACE_SEC`]: "1", [`${P}_STALE_SEC`]: "1", [`${P}_WAIT_SEC`]: "1" }), encoding: "utf8", timeout: 30_000 });
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.match(await readFile(join(root, "daemon.log"), "utf8"), /身份不符/);
});

test("日志轮转：daemon.log / keepalive.cron.log 超过 LOG_MAX_MB 时 copytruncate 成 .1", async () => {
  const root = await fakeRoot();
  const big = "x".repeat(1024 * 1024 + 10);
  await writeFile(join(root, "daemon.log"), big);
  await writeFile(join(root, "keepalive.cron.log"), "small\n");
  sourced("rotate_logs", { [`${P}_ROOT`]: root, [`${P}_LOG_MAX_MB`]: "1" });
  assert.equal(statSync(join(root, "daemon.log")).size, 0);
  assert.equal(statSync(join(root, "daemon.log.1")).size, big.length);
  assert.equal(await readFile(join(root, "keepalive.cron.log"), "utf8"), "small\n");
  assert.ok(!existsSync(join(root, "keepalive.cron.log.1")));
});

test("cron 条目把输出追加到 keepalive.cron.log（不再丢进 /dev/null）", async () => {
  const bin = await mkdtemp(join(tmpdir(), "ka-cron-"));
  const tab = join(bin, "tab");
  await writeFile(tab, "");
  await writeFile(join(bin, "crontab"), `#!/bin/bash\nif [ "$1" = "-l" ]; then cat ${JSON.stringify(tab)}; else cat > ${JSON.stringify(tab)}; fi\n`);
  await chmod(join(bin, "crontab"), 0o755);
  const root = await fakeRoot();
  const r = spawnSync("bash", [KA, "--install-cron"], { env: baseEnv({ [`${P}_ROOT`]: root, PATH: `${bin}:${process.env.PATH}` }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = (await readFile(tab, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(l.includes(`>>${join(root, "keepalive.cron.log")} 2>&1`), l);
    assert.ok(!l.includes("/dev/null"), l);
  }
});

test("hook 提示词：异常唤醒时用 keepalive.sh --force（跳过退避）", async () => {
  const j = JSON.parse(await readFile(HOOK_JSON, "utf8"));
  assert.ok(j.prompt.includes("keepalive.sh --force"));
});

test("飞书 hook 兜底拉起：带 NODE_BIN（PATH 里没有就读 .node-bin）和 MUSE_FEISHU_ROOT；纯数据目录时用 .keepalive-path", async () => {
  const home = await mkdtemp(join(tmpdir(), "mfb-heal-"));
  const br = join(home, "workspace", "muse-feishu-bridge");
  for (const d of ["inbox", "sent", "expired", "failed", "stop"]) await mkdir(join(br, d), { recursive: true });
  await writeFile(join(br, "package.json"), JSON.stringify({ name: "muse-feishu-bridge", version: "0.0.0" }, null, 2));
  await writeFile(join(br, "config.json"), "{}");
  const got = join(home, "ka-env.txt");
  await writeFile(join(br, "keepalive.sh"), `#!/bin/bash\necho "NODE_BIN=$NODE_BIN ROOT=$MUSE_FEISHU_ROOT" > ${JSON.stringify(got)}\n`);
  await writeFile(join(br, ".node-bin"), "/opt/fake-nvm/bin/node\n");
  await writeFile(join(br, "heartbeat.json"), JSON.stringify({ ts: Date.now() - 3600_000, connected: true }));
  const bin = join(home, "bin");
  await mkdir(bin);
  for (const tool of ["jq", "python3", "find", "date", "stat", "touch", "mkdir", "mv", "rm", "cat", "grep", "dirname", "wc", "tr", "setsid", "flock", "bash", "sed", "head", "printf", "mktemp", "env"]) {
    const w = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (w && w.startsWith("/")) spawnSync("ln", ["-s", w, join(bin, tool)]);
  }
  const rt = join(home, "rt.sh");
  await writeFile(rt, 'silent(){ echo "SILENT: $1"; exit 0; }\nwake(){ echo "WAKE: $1 $2"; exit 0; }\n');
  const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, HATCH_HOOK_RUNTIME: rt, PATH: bin };
  delete env.MUSE_FEISHU_ROOT;
  delete env.NODE_BIN;
  const r = spawnSync("bash", [HOOK], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WAKE: .*health_issue/);
  for (let i = 0; i < 30 && !existsSync(got); i++) await sleep(100);
  assert.equal((await readFile(got, "utf8")).trim(), `NODE_BIN=/opt/fake-nvm/bin/node ROOT=${br}`);
});

test("飞书 keepalive：MUSE_FEISHU_ROOT 是纯数据目录时用本仓库的 daemon.js，并记下 .node-bin / .keepalive-path", async () => {
  const data = await mkdtemp(join(tmpdir(), "mfb-data-"));
  assert.equal(sourced('echo "$DAEMON_JS"', { MUSE_FEISHU_ROOT: data }).stdout.trim(), join(REPO, "dist", "daemon.js"));
  sourced(`remember_paths ${JSON.stringify(process.execPath)}`, { MUSE_FEISHU_ROOT: data });
  assert.equal((await readFile(join(data, ".node-bin"), "utf8")).trim(), process.execPath);
  assert.equal((await readFile(join(data, ".keepalive-path"), "utf8")).trim(), KA);
});

