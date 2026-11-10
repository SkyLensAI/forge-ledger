/**
 * forge capture · 内容脚本（DOM 胶水）
 *
 * **这里没有任何判定。** 判定在 `@forge/core`（选择器配置能不能用、这个 URL 归谁管、
 * 一条记录的键是什么、哪些是增量），跑在 `forge serve` 那个本机进程里。
 * 这个文件只做三件浏览器才能做的事：
 *
 *   1. `querySelectorAll` 按选择器取值；
 *   2. 读**浏览器的时钟**，把页面上的相对时间（"3 分钟前"）折成 ISO 8601；
 *   3. 把结果发给桥。
 *
 * 为什么判定不能在这里：浏览器执行不了本仓库的 TypeScript（零构建，ADR-0011 靠的是
 * Node 的原生类型擦除）。把判定抄一份到这里，就会出现第二份实现，
 * 而两份实现漂移的方向永远是**浏览器那份更宽松**。
 *
 * 时间为什么必须在这里解：`relative-time` 那种元素只有在有"现在"的地方才解得开，
 * 而纯函数里没有"现在"。时钟留在宿主，判定才留得住确定性。
 */

const MAX_ITEMS_PER_PAGE = 200;

/**
 * 把页面上的时间折成 `YYYY-MM-DDTHH:MM:SSZ`。**解不开就返回 null**——
 * 不猜、不拿"现在"顶替（拿现在顶替等于伪造证据）。
 *
 * @param {string | null} raw
 * @returns {string | null}
 */
function toIsoSecond(raw) {
  if (raw === null) return null;
  const text = raw.trim();
  if (text.length === 0) return null;

  // 已经是绝对时间：`datetime` 属性通常是这个形状。
  const absolute = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (absolute !== null) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // 相对时间：`3 分钟前` / `2 hours ago` / `昨天 12:03`。
  const relative = /^(\d+)\s*(秒|分钟|小时|天|second|minute|hour|day|sec|min|hr)s?\s*(前|ago)$/i.exec(text);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? "").toLowerCase();
    const seconds =
      unit.startsWith("秒") || unit.startsWith("sec")
        ? 1
        : unit.startsWith("分") || unit.startsWith("min")
          ? 60
          : unit.startsWith("小时") || unit.startsWith("hour") || unit.startsWith("hr")
            ? 3600
            : 86_400;
    return new Date(Date.now() - amount * seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  return null;
}

/**
 * 按一组选择器从当前页面取值。
 *
 * @param {object} host
 * @returns {{items: Array<{text: string, author: string | null, time: string | null}>, skipped: string[]}}
 */
function readPage(host) {
  const items = [];
  const skipped = [];

  const root = typeof host.list === "string" ? document.querySelector(host.list) : document;
  if (root === null) skipped.push(`列表容器「${host.list}」没找到：这个站点的 DOM 大概变了（改的是配置，不是扩展）`);

  const nodes = root === null ? [] : [...root.querySelectorAll(host.item)].slice(0, MAX_ITEMS_PER_PAGE);
  if (nodes.length === 0) skipped.push(`记录选择器「${host.item}」一条都没命中`);

  for (const [index, node] of nodes.entries()) {
    const textNode = node.querySelector(host.fields.text);
    const text = (textNode ?? node).textContent?.trim() ?? "";
    if (text.length === 0) {
      skipped.push(`第 ${index + 1} 条记录的正文为空（选择器「${host.fields.text}」）`);
      continue;
    }

    const authorNode = typeof host.fields.author === "string" ? node.querySelector(host.fields.author) : null;
    // `relative-time` 之类的元素把绝对时间放在 `datetime` 属性里，那里比文本更可靠。
    const timeNode = typeof host.fields.time === "string" ? node.querySelector(host.fields.time) : null;
    const time = toIsoSecond(timeNode?.getAttribute("datetime") ?? timeNode?.textContent ?? null);

    items.push({
      text,
      author: authorNode?.textContent?.trim() ?? null,
      time,
    });
  }

  return { items, skipped };
}

/** 由 background 注入：当前该用哪一份选择器配置（背景脚本负责热更新与缓存）。 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "forge:read-page") return false;

  const host = message.host;
  if (host === null || typeof host !== "object") {
    sendResponse({ items: [], skipped: ["这个页面没有配置选择器：往配置里加一条（远端热更新，不用重新发扩展）"] });
    return false;
  }

  sendResponse(readPage(host));
  return false;
});
