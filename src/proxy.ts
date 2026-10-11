/**
 * 出网代理。飞书 SDK 的 REST（axios）和长连接（ws）对代理的处理不一样：
 * - axios 会自己读 HTTPS_PROXY，但对 https 目标走的是"绝对 URI 转发"而不是 CONNECT 隧道，部分代理不支持；
 * - ws 完全不读代理变量 → 只能经代理出网的环境里 REST 正常、长连接连不上（收不到消息）。
 * 这里统一成：有代理就给两者都挂同一个 CONNECT 隧道 agent（https-proxy-agent），并关闭 axios 自带的代理逻辑。
 * 遵守 NO_PROXY；config.proxy = "off" 可强制直连，填 URL 则覆盖环境变量。
 */
import { HttpsProxyAgent } from "https-proxy-agent";

export interface ProxyChoice {
  url: string | null;
  /** 去掉账号密码后的代理地址，用于日志 */
  label: string;
  source: "config" | "env" | "none" | "off" | "no_proxy";
}

function noProxyMatch(host: string, noProxy: string): boolean {
  for (const raw of noProxy.split(",")) {
    const p = raw.trim().toLowerCase().replace(/:\d+$/, "");
    if (!p) continue;
    if (p === "*") return true;
    const suf = p.startsWith(".") ? p : `.${p}`;
    if (host === p.replace(/^\./, "") || host.endsWith(suf)) return true;
  }
  return false;
}

export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(无法解析)";
  }
}

export function chooseProxy(target: string, cfgProxy: string | undefined, env: NodeJS.ProcessEnv = process.env): ProxyChoice {
  if (cfgProxy === "off") return { url: null, label: "直连（config.proxy=off）", source: "off" };
  if (cfgProxy && cfgProxy !== "auto") return { url: cfgProxy, label: redact(cfgProxy), source: "config" };
  const host = new URL(target).hostname.toLowerCase();
  const np = env.NO_PROXY ?? env.no_proxy ?? "";
  if (np && noProxyMatch(host, np)) return { url: null, label: "直连（NO_PROXY）", source: "no_proxy" };
  const url = env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || "";
  if (!url || !/^https?:\/\//i.test(url)) return { url: null, label: "直连", source: "none" };
  return { url, label: redact(url), source: "env" };
}

export function makeProxyAgent(url: string): HttpsProxyAgent<string> {
  // 注意：不要开 keepAlive。实测 https-proxy-agent@7 的 keepAlive CONNECT 隧道
  // 在某些代理（如 hatch-egress-proxy）上会 hang 住、请求超时；关掉后直连正常。
  return new HttpsProxyAgent(url);
}

/**
 * 给 axios 默认配置挂代理：始终关掉 axios 自己读 HTTP(S)_PROXY 的逻辑（proxy=false），
 * 有代理时用 CONNECT 隧道 agent；没有（"off"、NO_PROXY、未配置）就是真正直连。
 */
export function applyAxiosProxy(defaults: Record<string, unknown>, agent: object | undefined): void {
  defaults.proxy = false;
  if (agent) {
    defaults.httpsAgent = agent;
    defaults.httpAgent = agent;
  }
}
