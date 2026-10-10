/**
 * feishu-retry.ts — 飞书 REST 调用的短重试 + 错误分类。
 *
 * 飞书 Node SDK 的错误有两种形状：
 *   1. HTTP 4xx/5xx → axios 抛错，e.response.status / e.response.data.{code,msg}；
 *   2. HTTP 200 但业务 code ≠ 0 → SDK 正常 resolve 一个 {code, msg}（不会抛错！）。
 * 原版只处理第 1 种，第 2 种被当成发送成功。这里用 assertOk() 把第 2 种也变成 FeishuApiError。
 */
import { setTimeout as delay } from "node:timers/promises";

const MAX_ATTEMPTS = 3;

/** 业务错误码里属于"稍后重试可能成功"的（限频、服务端繁忙、token 刷新中）。 */
export const RETRYABLE_FEISHU_CODES = new Set<number>([
  99991400, // 请求频率超限
  99991663, // tenant_access_token 失效（SDK 会刷新）
  99991661, // token 格式错误/缺失（同上，刷新后通常恢复）
  230020, // 消息发送频率超限
  1000004, // 内部错误，稍后重试
  1500, // 服务内部错误
]);

export class FeishuApiError extends Error {
  constructor(
    readonly code: number,
    msg: string,
    readonly httpStatus?: number,
  ) {
    super(`飞书接口错误 code=${code}${httpStatus ? ` http=${httpStatus}` : ""}: ${msg}`);
    this.name = "FeishuApiError";
  }
}

/** SDK resolve 的结果里 code ≠ 0 视为失败。 */
export function assertOk<T>(res: T): T {
  const r = res as { code?: unknown; msg?: unknown } | null | undefined;
  if (r && typeof r === "object" && typeof r.code === "number" && r.code !== 0) {
    throw new FeishuApiError(r.code, String(r.msg ?? ""));
  }
  return res;
}

export async function withFeishuRetry<T>(operation: () => Promise<T>, _label: string): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return assertOk(await operation());
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableFeishuError(error)) throw error;
      await delay(250 * 2 ** (attempt - 1));
    }
  }
}

export function httpStatusOf(error: unknown): number | undefined {
  const raw = error as any;
  const s = Number(raw?.httpStatus ?? raw?.response?.status ?? raw?.response?.statusCode ?? raw?.statusCode ?? raw?.status);
  return Number.isInteger(s) && s >= 100 && s < 600 ? s : undefined;
}

export function feishuCodeOf(error: unknown): number | undefined {
  const raw = error as any;
  if (error instanceof FeishuApiError) return error.code;
  const c = raw?.response?.data?.code;
  return typeof c === "number" && c !== 0 ? c : undefined;
}

export function isRetryableFeishuError(error: unknown): boolean {
  const raw = error as any;
  const code = feishuCodeOf(error);
  if (code !== undefined && RETRYABLE_FEISHU_CODES.has(code)) return true;
  const status = httpStatusOf(error);
  if (status !== undefined && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const sys = String(raw?.code || raw?.cause?.code || "").toUpperCase();
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EPIPE"].includes(sys)) return true;
  if (code !== undefined || (status !== undefined && status >= 400 && status < 500)) return false;
  const message = String(raw?.message || error || "").toLowerCase();
  return /(timeout|timed out|network|socket|connection reset|fetch failed|eai_again|enotfound)/i.test(message);
}

/**
 * 永久错误：重发也不会成功（参数错误、无权限、机器人不在群里、原消息已撤回…）。
 * 判据：不可重试 且（HTTP 4xx 或 带业务 code）。既无状态码也无业务码的未知错误按临时错误处理（有次数上限）。
 */
export function isPermanentFeishuError(error: unknown): boolean {
  if (isRetryableFeishuError(error)) return false;
  const status = httpStatusOf(error);
  return feishuCodeOf(error) !== undefined || (status !== undefined && status >= 400 && status < 500);
}

/** 错误描述：带上飞书业务 code / msg（axios 错误的 message 只有 "status code 400"，看不出原因）。 */
export function describeFeishuError(error: unknown): string {
  const raw = error as any;
  const base = error instanceof Error ? error.message : String(error);
  const code = feishuCodeOf(error);
  if (code !== undefined && !(error instanceof FeishuApiError)) {
    const msg = raw?.response?.data?.msg;
    return `${base}（飞书 code=${code}${msg ? `: ${String(msg).slice(0, 200)}` : ""}）`;
  }
  return base;
}
