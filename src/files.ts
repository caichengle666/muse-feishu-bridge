/**
 * files.ts — 外发文件（outbox 的 file / images 字段）的安全校验与媒体类型识别。
 *
 * 规则（0.2.0）：
 *  - 必须是绝对路径；realpath 解析符号链接后再判断（防 symlink 绕过）；
 *  - 只允许落在 allowedRoots（默认 <ROOT>/outgoing 与 os.tmpdir()、/tmp）之下；
 *  - 即使在允许根下，<ROOT> 内除 outgoing/ 以外一律拒绝（防 ROOT 恰好在 /tmp 下时泄露 secrets）；
 *  - 拒绝敏感文件名：*.env、.env*、secrets*、state.json、heartbeat.json、config.json、
 *    routes.json、seen.json、card_events.json、debug.log、daemon.pid、id_rsa* / id_ed25519* 等私钥、*.pem、*.key，及 .ssh/.gnupg 目录下的文件。
 *
 * 0.2.1 硬链接绕过：硬链接不是符号链接，realpath 解析不出原文件（例如在 /tmp 下 `ln <ROOT>/secrets.env /tmp/x.txt`）。
 *  - lstat 目标，nlink > 1 一律拒绝；
 *  - 另外收集 ROOT 下的敏感文件（secrets.env、config.json、state.json… 及 ROOT 顶层所有命中敏感名规则的文件）的 dev+ino，
 *    待发文件的 dev+ino 与其中任何一个相同也拒绝（防"原文件已删、只剩一个链接"之外的各种变体）。
 */
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

export type MediaType = "file" | "image" | "voice" | "video";

export function detectMediaType(filename: string): MediaType {
  const ext = filename.toLowerCase().split(".").pop() || "";
  if (["mp4", "mov", "avi", "mkv", "wmv", "m4v"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (["mp3", "wav", "amr", "m4a", "ogg", "aac"].includes(ext)) return "voice";
  return "file";
}

const DENY_BASENAME: RegExp[] = [
  /\.env$/i,
  /^\.env/i,
  /^secrets/i,
  /^state\.json$/i,
  /^heartbeat\.json$/i,
  /^config\.json$/i,
  /^routes\.json$/i,
  /^seen\.json$/i,
  /^dedupe\.json$/i,
  /^daemon\.pid$/i,
  /^daemon\.lock/i,
  /^card_events\.json$/i,
  /^debug\.log/i,
  /^daemon\.log/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.pem$/i,
  /\.key$/i,
  /^\.?netrc$/i,
  /^\.npmrc$/i,
];
const DENY_DIR_SEGMENTS = new Set([".ssh", ".gnupg", ".aws"]);

export function isDeniedName(p: string): boolean {
  const b = basename(p);
  if (DENY_BASENAME.some((re) => re.test(b))) return true;
  return p.split(sep).some((seg) => DENY_DIR_SEGMENTS.has(seg));
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** 默认允许根：<ROOT>/outgoing、os.tmpdir()、/tmp（去重）。 */
export function defaultAllowedRoots(root: string): string[] {
  return [...new Set([join(root, "outgoing"), tmpdir(), "/tmp"])];
}

export function resolveAllowedRoots(root: string, configured?: string[]): string[] {
  if (configured && configured.length) return configured.map((p) => resolve(root, expandHome(p)));
  return defaultAllowedRoots(root);
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

function within(child: string, parent: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(p);
}

/** ROOT 下固定的敏感文件（无论文件名规则如何变化都纳入 dev+ino 黑名单） */
export const ROOT_DENY_FILES = [
  "secrets.env",
  "config.json",
  "state.json",
  "heartbeat.json",
  "routes.json",
  "cards.json",
  "card_events.json",
  "daemon.pid",
  "daemon.lock",
  ".env",
];

/** 收集 ROOT 下敏感文件的 "dev:ino" 集合。 */
export async function denyInodes(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  const names = new Set(ROOT_DENY_FILES);
  try {
    for (const n of await readdir(root)) if (isDeniedName(n)) names.add(n);
  } catch {
    /* ROOT 不可读 */
  }
  for (const n of names) {
    try {
      const st = await stat(join(root, n));
      if (st.isFile()) out.add(`${st.dev}:${st.ino}`);
    } catch {
      /* 不存在 */
    }
  }
  return out;
}

export type FileCheck =
  | { ok: true; realPath: string; filename: string; size: number }
  | { ok: false; reason: string };

export interface FileCheckOptions {
  root: string;
  allowedRoots: string[];
  maxBytes?: number;
  /** 只允许这些扩展名（含点，小写），如 [".jpg", ".png"] */
  exts?: string[];
}

export async function checkOutgoingFile(p: unknown, opts: FileCheckOptions): Promise<FileCheck> {
  const maxBytes = opts.maxBytes ?? 30 * 1024 * 1024;
  if (typeof p !== "string" || !p) return { ok: false, reason: "文件路径为空" };
  if (!isAbsolute(p)) return { ok: false, reason: "文件路径必须是绝对路径" };
  if (isDeniedName(p)) return { ok: false, reason: "文件名属于敏感文件，禁止发送" };
  const real = await realOrNull(p);
  if (!real) return { ok: false, reason: "文件不存在" };
  if (isDeniedName(real)) return { ok: false, reason: "文件名属于敏感文件，禁止发送" };

  const roots = (await Promise.all(opts.allowedRoots.map(realOrNull))).filter((x): x is string => !!x);
  if (!roots.some((r) => within(real, r))) return { ok: false, reason: "文件路径不在允许范围" };

  const realRoot = (await realOrNull(opts.root)) || resolve(opts.root);
  const realOutgoing = (await realOrNull(join(opts.root, "outgoing"))) || join(realRoot, "outgoing");
  if ((real === realRoot || within(real, realRoot)) && !within(real, realOutgoing)) {
    return { ok: false, reason: "项目目录内只允许发送 outgoing/ 下的文件" };
  }

  if (opts.exts && !opts.exts.some((e) => real.toLowerCase().endsWith(e))) {
    return { ok: false, reason: `仅支持 ${opts.exts.join("/")} 格式` };
  }
  let size: number;
  try {
    const st = await lstat(real);
    if (!st.isFile()) return { ok: false, reason: "不是文件" };
    if (st.nlink > 1) return { ok: false, reason: "文件有多个硬链接，禁止发送" };
    if ((await denyInodes(realRoot)).has(`${st.dev}:${st.ino}`)) {
      return { ok: false, reason: "文件与项目内的敏感文件是同一个 inode，禁止发送" };
    }
    size = st.size;
  } catch {
    return { ok: false, reason: "文件不可读" };
  }
  if (size > maxBytes) {
    return { ok: false, reason: `文件过大（${(size / 1048576).toFixed(1)}MB，上限 ${(maxBytes / 1048576).toFixed(0)}MB）` };
  }
  return { ok: true, realPath: real, filename: basename(real), size };
}
