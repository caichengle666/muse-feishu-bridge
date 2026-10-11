/**
 * onboard.ts — 扫码创建飞书应用（npm run onboard）。
 *
 * 用飞书官方 SDK 的 registerApp（OAuth 设备码流程）：
 *   1. 向 accounts.feishu.cn 申请一个确认链接，生成二维码（终端打印 + 保存 onboard-qr.png）；
 *   2. 用户用手机飞书扫码，在飞书自己的确认页核对机器人名称和权限，点确认；
 *   3. 本脚本轮询拿到 App ID / App Secret 和扫码人的 open_id：
 *      - 凭证写入 secrets.env（600，不打印）；
 *      - 扫码人加入 config.json 的 allowedOpenIds（白名单）并设为 ownerOpenId；
 *      - 国际版（Lark）租户自动把 domain 设为 lark。
 * 所需权限、长连接事件 im.message.receive_v1、卡片回调 card.action.trigger 都通过 addons 预填到确认页，
 * 确认即生效，不用进开发者后台、不用手动发布版本。
 *
 * 用法：
 *   npm run onboard -- --name "我的 Muse"     新建应用（名称建好后不能用扫码流程改，先定好）
 *   npm run onboard -- --update-permissions  已有应用扫一次码补齐权限（读 secrets.env 里的 App ID）
 * 扫码流程不可用时，照 README 手动建应用、把凭证写进 secrets.env 即可。
 */
import { readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import QRCode from "qrcode";
import { makePaths, resolveRoot } from "./paths.js";
import { parseEnvFile } from "./config.js";
import { atomicWriteJson } from "./fsutil.js";

/** 桥接需要的全部权限 / 事件 / 回调（与 README「权限」一节保持一致） */
export const REQUIRED_SCOPES = [
  "im:message",
  "im:message.p2p_msg:readonly",
  "im:message:send_as_bot",
  "im:message.group_at_msg:readonly",
  "im:message.group_at_msg.include_bot:readonly",
  "im:message:update",
  "im:message.reactions:write_only",
  "im:resource",
  "im:chat:readonly",
  "cardkit:card:write",
];
export const REQUIRED_ADDONS = {
  scopes: { tenant: REQUIRED_SCOPES },
  events: { items: { tenant: ["im.message.receive_v1"] } },
  callbacks: { items: ["card.action.trigger"] },
};

export interface OnboardArgs {
  name?: string;
  updatePermissions: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): OnboardArgs {
  const out: OnboardArgs = { updatePermissions: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") out.name = (argv[++i] || "").trim() || undefined;
    else if (a.startsWith("--name=")) out.name = a.slice(7).trim() || undefined;
    else if (a === "--update-permissions") out.updatePermissions = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return out;
}

/** 写回 secrets.env：只替换 FEISHU_APP_ID / FEISHU_APP_SECRET（及旧键名），保留其他行。 */
export function mergeSecrets(existing: string, appId: string, appSecret: string): string {
  const drop = /^\s*(export\s+)?(FEISHU_APP_ID|FEISHU_APP_SECRET|APP_ID|APP_SECRET)\s*=/;
  const kept = existing.split(/\r?\n/).filter((l) => !drop.test(l));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  if (!kept.length) kept.push("# 飞书应用凭证（npm run onboard 扫码写入；chmod 600，不要提交）");
  return [...kept, `FEISHU_APP_ID=${appId}`, `FEISHU_APP_SECRET=${appSecret}`, ""].join("\n");
}

/** 合并 config.json：扫码人进白名单、做主人；Lark 租户设 domain。其余键原样保留。 */
export function mergeConfig(cfg: Record<string, unknown>, openId: string | undefined, brand: string | undefined): Record<string, unknown> {
  const out = { ...cfg };
  if (openId) {
    const list = Array.isArray(out.allowedOpenIds) ? (out.allowedOpenIds as unknown[]).filter((x): x is string => typeof x === "string" && x !== "ou_xxx") : [];
    if (!list.includes(openId)) list.unshift(openId);
    out.allowedOpenIds = list;
    if (typeof out.ownerOpenId !== "string" || !out.ownerOpenId || out.ownerOpenId === "ou_xxx") out.ownerOpenId = openId;
  }
  if (brand === "lark") out.domain = "lark";
  return out;
}

const mask = (s: string) => (s.length <= 8 ? "***" : `${s.slice(0, 6)}…${s.slice(-3)}`);

async function main(): Promise<number> {
  let args: OnboardArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String((e as Error).message));
    return 2;
  }
  if (args.help) {
    console.log('用法：npm run onboard -- [--name "机器人名称"] [--update-permissions]');
    return 0;
  }
  const paths = makePaths(resolveRoot());
  const secretsRaw = existsSync(paths.secrets) ? await readFile(paths.secrets, "utf8") : "";
  const env = parseEnvFile(secretsRaw);
  const existingAppId = env.FEISHU_APP_ID || env.APP_ID || "";
  let cfg: Record<string, unknown> = {};
  if (existsSync(paths.config)) {
    try {
      cfg = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    } catch {
      console.error(`[onboard] ${paths.config} 不是合法 JSON，先修好再扫码（没有改动任何文件）`);
      return 2;
    }
  } else {
    const example = join(paths.root, "config.example.json");
    if (existsSync(example)) cfg = JSON.parse(await readFile(example, "utf8")) as Record<string, unknown>;
  }

  if (args.updatePermissions) {
    if (!/^cli_[A-Za-z0-9]+$/.test(existingAppId)) {
      console.error("[onboard] --update-permissions 需要 secrets.env 里已有 FEISHU_APP_ID（cli_ 开头）；还没建应用就去掉这个参数");
      return 2;
    }
    console.log(`[onboard] 更新模式：给已有应用 ${mask(existingAppId)} 补齐权限，扫码确认后生效（这个流程不能改名）`);
  } else {
    if (existingAppId) console.log(`[onboard] 注意：secrets.env 里已有应用 ${mask(existingAppId)}，扫码成功后会被新应用替换（只想补权限用 --update-permissions）`);
    console.log(`[onboard] 机器人名称将预填为「${args.name || "{你的名字} 的 Muse"}」，确认页上还能改；建好后不能再用扫码改名`);
  }

  const qrPath = join(paths.root, "onboard-qr.png");
  const result = await lark.registerApp({
    source: "muse-feishu-bridge",
    onQRCodeReady: async (info: { url: string; expireIn: number }) => {
      console.log("[onboard] 用手机飞书扫下面的二维码（或在手机上打开这个链接），核对名称和权限后点确认：");
      console.log(`[onboard] ${info.url}`);
      console.log(`[onboard] 链接 ${Math.round(info.expireIn / 60)} 分钟内有效`);
      try {
        await QRCode.toFile(qrPath, info.url, { width: 360, margin: 2 });
        console.log(`[onboard] 二维码图片：${qrPath}`);
        console.log(await QRCode.toString(info.url, { type: "terminal", small: true }));
      } catch (e) {
        console.log(`[onboard] 生成二维码图片失败（${String((e as Error).message)}），直接用上面的链接`);
      }
      console.log("[onboard] 等待扫码确认…");
    },
    onStatusChange: (info: { status: string }) => {
      if (info.status === "domain_switched") console.log("[onboard] 检测到国际版（Lark）租户，已切换");
    },
    ...(args.updatePermissions
      ? { appId: existingAppId }
      : { createOnly: true, appPreset: { name: args.name || "{user} 的 Muse", desc: "Muse 个人助手的飞书入口（muse-feishu-bridge）" } }),
    addons: REQUIRED_ADDONS,
  } as Parameters<typeof lark.registerApp>[0]);

  const appId = result.client_id;
  const appSecret = result.client_secret;
  if (args.updatePermissions && appId !== existingAppId) {
    console.error("[onboard] 返回的 App ID 与原应用不一致，已中止，没有改动任何文件");
    return 2;
  }
  await writeFile(paths.secrets, mergeSecrets(secretsRaw, appId, appSecret), { mode: 0o600 });
  await chmod(paths.secrets, 0o600);
  const openId = result.user_info?.open_id;
  const next = mergeConfig(cfg, openId, result.user_info?.tenant_brand);
  await atomicWriteJson(paths.config, next);
  await rmQuiet(qrPath);

  console.log("[onboard] 成功");
  console.log(`[onboard]   App ID：${mask(appId)}（App Secret 已写入 secrets.env，不显示）`);
  console.log(`[onboard]   白名单 / 主人：${openId ? mask(openId) : "没拿到 open_id，启动后给机器人发条私聊，用 /ids 查到再填 allowedOpenIds"}`);
  console.log(`[onboard]   域名：${next.domain === "lark" ? "lark（国际版）" : "feishu"}`);
  console.log("[onboard] 下一步：npm run check-config && bash keepalive.sh（已在运行的 daemon 要重启才会用新凭证）");
  return 0;
}

async function rmQuiet(p: string) {
  const { rm } = await import("node:fs/promises");
  await rm(p, { force: true }).catch(() => undefined);
}

const isMain = process.argv[1] && /onboard\.js$/.test(process.argv[1]);
if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      const msg = String((e as Error)?.message || e);
      console.error(`[onboard] 失败：${msg}`);
      if (/access_denied/i.test(msg)) console.error("[onboard] 你在确认页点了拒绝，重新运行即可");
      else if (/expired/i.test(msg)) console.error("[onboard] 二维码过期了，重新运行生成新的");
      else console.error("[onboard] 扫码流程不可用时，按 README 手动建应用，把凭证写进 secrets.env");
      process.exit(1);
    },
  );
}
