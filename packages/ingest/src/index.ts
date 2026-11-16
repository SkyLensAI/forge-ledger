/**
 * `@forge/ingest` —— 采集层。
 *
 * 一个连接器 = 一个来源格式的纯解析器。它们**不做 IO**：
 * 读文件、写 sources 层、记账丢弃了哪些记录，都是 `@forge/store` 与 CLI 的事。
 *
 * 连接器注册表放在这里而不是散落各处：`meta.json` 里只存 connector id，
 * 出处解析（`src://…#k:`）要按 id 找回**同一个**解析器。
 * 换一份实现去做校验，两份实现必然漂移，而漂移的方向永远是校验那份更宽松。
 */
import type { SourceConnector } from "./contracts.ts";
import { officialExportConnector } from "./connectors/official-export.ts";
import { webCaptureConnector } from "./connectors/web-capture.ts";

export * from "./contracts.ts";
export * from "./connectors/official-export.ts";
export * from "./connectors/web-capture.ts";

/**
 * 已知连接器，按 id 索引。
 *
 * 顺序**有意义**：`detectConnector` 按这个顺序问，第一个说"这是我认得的格式"的赢。
 * 导出在前、采集在后——采集载荷的判据更具体（`capture_version` + `host`），
 * 但让更常见的那个先被问到，能让"选错连接器"这件事的概率再低一点。
 */
export const CONNECTORS: ReadonlyMap<string, SourceConnector> = new Map(
  [officialExportConnector, webCaptureConnector].map((connector) => [connector.id, connector]),
);

/**
 * @param {string} id
 * @returns {SourceConnector | null}
 */
export function connectorById(id: string): SourceConnector | null {
  return CONNECTORS.get(id) ?? null;
}

/**
 * 按内容挑连接器。挑不到就返回 null——**不猜**：
 * "有连接器勉强能解析"和"这是它认得的格式"是两件事。
 *
 * @param {string} text
 * @returns {SourceConnector | null}
 */
export function detectConnector(text: string): SourceConnector | null {
  for (const connector of CONNECTORS.values()) {
    if (connector.accepts(text)) return connector;
  }
  return null;
}
