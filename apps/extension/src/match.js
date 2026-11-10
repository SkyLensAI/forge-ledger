/**
 * "这个 URL 归哪个站点管" —— 扩展里**唯一**与判定同形的一段。
 *
 * 它之所以存在：浏览器执行不了 `@forge/core` 的 TypeScript，而这个判断必须在
 * 页面这一侧发生（要知道当前 tab 的 URL 才谈得上采集）。
 * 于是这里有一条**成文的重复**，而重复的处置办法不是"假装没有"，是：
 *
 * 1. 判据写成最小的一行（最长前缀赢，同长按字典序）；
 * 2. `apps/extension/test/extension.test.ts` 拿一张 URL 表，把这里的输出与
 *    `@forge/core` 的 `hostForUrl` **逐条比对**——两份实现漂移的那一刻，测试就红。
 *
 * 没有这个测试，"扩展里有一份判定"迟早会变成"扩展里的判定更宽松"。
 */

/**
 * @param {{hosts?: Array<{match?: unknown}>}} config
 * @param {string} url
 * @returns {object | null}
 */
export function hostFor(config, url) {
  const hosts = Array.isArray(config?.hosts) ? config.hosts : [];
  const candidates = hosts
    .filter((host) => typeof host.match === "string" && url.startsWith(host.match))
    .sort((a, b) => (a.match.length !== b.match.length ? b.match.length - a.match.length : a.match < b.match ? -1 : 1));
  return candidates[0] ?? null;
}
