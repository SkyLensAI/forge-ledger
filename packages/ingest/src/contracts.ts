/**
 * 连接器契约 —— 纯解析，零 IO。
 *
 * 为什么连接器是**纯函数**：它接受"一份文件的全部文本"，返回记录。
 * 读文件、决定写到哪、什么时候写，都是 store 的事。
 * 这条边界不是洁癖，它换来两件具体的东西：
 *   1. 连接器可以用固定字符串测试（真实导出文件进不了 git——R1/R9）。
 *   2. 出处解析（`src://…#k:`）可以直接复用连接器：**换一份实现去做校验，
 *      两份实现必然漂移**，而漂移的方向永远是"校验那份更宽松"。
 */
import type { RawRecord } from "@forge/core";

export interface SkippedRecord {
  /** 记录在导出文件里的位次，用来让人回去找它。 */
  index: number;
  reason: string;
}

export interface ConnectorParseResult {
  records: RawRecord[];
  skipped: SkippedRecord[];
}

/**
 * 一个来源格式的解析器。
 *
 * `accepts` 存在的理由：导入时最常见的事故是"选错了文件"。
 * 让人拿到 EmptyLibrary 比拿到 0 条记录好——后者看起来像是导出文件坏了。
 */
export interface SourceConnector {
  /** 稳定标识，写进 `sources/<id>/meta.json`，出处解析靠它找回同一个解析器。 */
  id: string;
  mediaType: string;
  accepts(text: string): boolean;
  parse(text: string): ConnectorParseResult;
}
