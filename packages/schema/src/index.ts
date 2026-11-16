/**
 * `@forge/schema` —— 分类法的代码侧一半。
 *
 * 人读的一半在 `schema/`（YAML + 模板 + 两份规范），两者由闸门机器比对（ADR-0010）。
 * 这个包只做**数据与校验**：零业务判断、零文件读写。
 * "这条资产合不合格"是 `@forge/core` 的事——分开的理由是同一个判定要跑在
 * 四个宿主里，而两个包各自被替换的成本相差一个数量级。
 */
export * from "./fields.ts";
export * from "./base32.ts";
export * from "./validate.ts";
export * from "./ids.ts";
export * from "./events.ts";
export * from "./assets.ts";
export * from "./taxonomy.ts";
