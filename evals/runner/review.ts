/**
 * golden 集的**确认**与**指纹** —— 两份尺子共用的那一小段。
 *
 * 为什么它单独一个文件：extraction 与 conflict 两把尺子的确认机制必须是**同一份**
 * （ADR-0020：确认绑在内容指纹上，不绑在文件名上）。各写一份的结局是
 * 两把尺子的"确认"含义悄悄分叉——而"有人点过头"这句话只有在两份实现完全一样时
 * 才能被信任。
 *
 * 它同时解掉一个实际的问题：`run.ts` 与 `conflict.ts` 互相引用会形成循环导入
 * （探针要读 golden 集与指纹，而 runner 要跑探针）。把共用的一小段提到中间层，
 * 两边各自指向它，环就没了。
 */
import { createHash } from "node:crypto";
import { stableJson } from "../../packages/store/src/index.ts";

/**
 * 一份 golden 集的确认记录。
 *
 * `cases_sha256` 是**被确认那一份**用例的指纹；闸门比对的是**当前**这一份。
 * 于是改一个字节就要重新确认（`E2` 会红）——"有人点过头"如果只是一面旗，
 * 它就能被盖在任何后续改动上，包括 agent 事后往 golden 集里塞一条恰好变准的用例。
 */
export interface ReviewRecord {
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  cases_sha256?: string;
  method?: string;
}

/**
 * 指纹：**规范化之后**再哈希。
 *
 * 用 `stableJson`（键递归排序）而不是 `JSON.stringify`：后者保留插入顺序，
 * 于是"把 `why` 挪到 `type` 前面"这种纯排版改动也会让指纹变。
 * 指纹要绑的是**内容**，不是键的书写顺序——一次因为排版而失效的确认，
 * 只会训练人闭着眼睛重签。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function digestOf(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}
