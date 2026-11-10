/**
 * `@forge/core` —— 编译与维护引擎（R5：零 IO、纯函数）。
 *
 * 这个包里的每个函数都只依赖输入：不读文件、不碰网络、不看时钟。
 * 于是同一份引擎可以跑在 CLI、MCP server、桌面端、云端 worker 里，
 * 并且可以用固定字符串做快照测试（ADRs 都靠这个）。
 *
 * IO 在三个边缘包里：`@forge/store`（文件与 SQLite）、`@forge/ingest`（导出格式解析）、
 * `apps/cli`（参数与进程）。
 */
export * from "./provenance.ts";
export * from "./violation.ts";
export * from "./json.ts";
export * from "./audit.ts";
export * from "./asset.ts";
export * from "./health.ts";
export * from "./report.ts";
export * from "./normalize.ts";
export * from "./compile.ts";
export * from "./emit.ts";
export * from "./emit-skill.ts";
export * from "./extract.ts";
export * from "./link.ts";
export * from "./conflict.ts";
export * from "./model.ts";
export * from "./guard.ts";
export * from "./retrieve.ts";
export * from "./selectors.ts";
export * from "./evaluation.ts";
export * from "./team.ts";
export * from "./bootstrap.ts";
export * from "./distribution.ts";
export * from "./demo.ts";
export * from "./projection.ts";
