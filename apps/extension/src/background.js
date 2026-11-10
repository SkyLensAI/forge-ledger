/**
 * forge capture · 背景脚本（service worker，MV3）
 *
 * 它的职责只有四件，四件都是"浏览器 ↔ 本机桥"的接线：
 *
 *   1. 读选项（桥的地址与 token），没有就说清楚"还没配"；
 *   2. 向桥要**当前该用哪一份选择器配置**（热更新的那一半：桥拿远端，扩展缓存结果）；
 *   3. 采集时把页面值报给桥（`POST /capture`），由桥去键、去重、落 sources；
 *   4. 取用时把当前的查询发给桥（`GET /context`），回一段注入。
 *
 * **判定不在这里**：比较 revision、决定用谁、算键、去重——都在 `@forge/core`
 * 与 `forge serve` 里（浏览器执行不了那份 TypeScript，理由见 `content.js` 的头注释）。
 * 这里只剩 `if (decision.use === "remote")` 这种读字段的胶水。
 *
 * 热更新的缓存策略：拿到远端配置就存进 `chrome.storage.local`。
 * 桥没开、网断、远端配置服务器挂了——扩展仍然用**上一次拿到的那份**，
 * 而不是退回随包的那份：一次改版之后，随包的那份已经不管用了。
 */

import { hostFor } from "./match.js";

const BUNDLED = "selectors.default.json";
const CACHE_KEY = "forge.selectors.cache";
const OPTIONS_KEY = "forge.bridge";

/** @returns {Promise<{url: string, token: string}>} */
async function bridgeOptions() {
  const stored = await chrome.storage.local.get(OPTIONS_KEY);
  const value = stored[OPTIONS_KEY] ?? {};
  return {
    url: typeof value.url === "string" && value.url.length > 0 ? value.url : "http://127.0.0.1:8787",
    token: typeof value.token === "string" ? value.token : "",
  };
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function callBridge(path, init = {}) {
  const { url, token } = await bridgeOptions();
  const headers = { ...(init.headers ?? {}), "x-forge-token": token };
  return fetch(`${url.replace(/\/+$/, "")}${path}`, { ...init, headers });
}

/** 随包的那份兜底配置。 */
async function bundledConfig() {
  const response = await fetch(chrome.runtime.getURL(BUNDLED));
  return response.json();
}

/**
 * 当前该用的配置：**向桥要结论**，拿到远端就缓存，拿不到就用缓存，再没有就用随包的。
 *
 * @returns {Promise<object>}
 */
async function currentConfig() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cache = stored[CACHE_KEY] ?? null;
  const bundled = await bundledConfig();
  const have = cache ?? bundled;

  try {
    const response = await callBridge(`/selectors?have=${encodeURIComponent(String(have.revision ?? 0))}`);
    if (response.ok) {
      const decision = await response.json();
      if (decision.use === "remote") {
        await chrome.storage.local.set({ [CACHE_KEY]: decision.config });
        return decision.config;
      }
      // 桥说"用你手里那份"：手里的缓存已经过时了（扩展更新过），清掉它。
      if (cache !== null) await chrome.storage.local.remove(CACHE_KEY);
      return bundled;
    }
  } catch {
    // 桥没开：这不是错误，是常见状态。用缓存/兜底继续。
  }
  return have;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "forge:capture") {
    captureFromTab(sender.tab).then(sendResponse);
    return true; // 异步回复
  }
  if (message?.type === "forge:context") {
    queryContext(message.query).then(sendResponse);
    return true;
  }
  return false;
});

/**
 * 采一页。
 *
 * @param {chrome.tabs.Tab | undefined} tab
 * @returns {Promise<object>}
 */
async function captureFromTab(tab) {
  if (tab?.id === undefined || typeof tab.url !== "string") return { ok: false, reason: "拿不到当前标签页" };

  const config = await currentConfig();
  const host = hostFor(config, tab.url);
  if (host === null) {
    return {
      ok: false,
      reason: `这个页面没有配置选择器（${tab.url}）。往选择器配置里加一条就行——远端热更新，不用重新发扩展。`,
    };
  }

  let read;
  try {
    read = await chrome.tabs.sendMessage(tab.id, { type: "forge:read-page", host });
  } catch {
    // 内容脚本没注入（比如页面在扩展安装之前就打开了）。
    return { ok: false, reason: "这个页面上没有内容脚本：刷新一下页面再试。" };
  }

  const report = {
    host: host.match,
    label: host.label,
    page: tab.url,
    items: read.items ?? [],
    skipped: read.skipped ?? [],
  };
  if (report.items.length === 0) {
    // "什么都没采到"与"没有新东西"是两件事：把 skipped 带上去，让它能被看见。
    return { ok: false, reason: "这一页没采到任何记录", skipped: report.skipped };
  }

  try {
    const response = await callBridge("/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    const outcome = await response.json();
    return { ...outcome, skipped: [...(outcome.skipped ?? []), ...report.skipped] };
  } catch (error) {
    return { ok: false, reason: `桥连不上（${String(error)}）。跑 \`forge serve\`，并把 token 填进选项页。` };
  }
}

/**
 * @param {string} query
 * @returns {Promise<object>}
 */
async function queryContext(query) {
  try {
    const response = await callBridge(`/context?q=${encodeURIComponent(query)}`);
    const text = await response.text();
    return response.ok ? { ok: true, text } : { ok: false, reason: text };
  } catch (error) {
    return { ok: false, reason: `桥连不上（${String(error)}）。跑 \`forge serve\`，并把 token 填进选项页。` };
  }
}
