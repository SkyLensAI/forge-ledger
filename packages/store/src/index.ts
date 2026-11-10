/**
 * `@forge/store` —— 存储实现：三层（S8）、候选区（S16）与它们的 IO。
 *
 * 这里是**唯一**允许碰文件系统的地方（连同 `apps/cli` 的参数与进程）。
 * 判定与编译逻辑全在 `@forge/core`，所以同一套规则既能跑用户的库，
 * 也能跑本仓库自己的 ADR（自举），而不会出现两份会漂移的实现。
 */
export * from "./paths.ts";
export * from "./sources.ts";
export * from "./audit.ts";
export * from "./assets.ts";
export * from "./indexdb.ts";
export * from "./spans.ts";
export * from "./inbox.ts";
export * from "./conflicts.ts";
export * from "./cassette.ts";
export * from "./selectors.ts";
export * from "./projection.ts";
export * from "./vault.ts";
