# 0009 · Windows 上 CLI 一行都跑不起来

> 发现于实现 docs/personal.md 迭代 0 的时候。发现方式：在 Windows 上照 README 的
> 快速开始执行 `node apps/cli/src/main.ts --help`，得到的不是用法，而是
> `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。

## 当初以为是什么

README 的快速开始写的是 `node apps/cli/src/main.ts`，并假设 Node 24 的原生类型擦除
足够跑源码——ADR-0011 选的就是这条路，而且在 Linux / macOS 上确实成立。

## 实际是什么

Node 的原生类型擦除**明确拒绝执行 `node_modules` 下的 `.ts`**。
Linux 上 pnpm 用符号链接，Node 解析时会 realpath 到 `packages/.../src/index.ts`，
所以不在 `node_modules` 下；**Windows 上没有符号链接权限时，pnpm 退回 junction**，
解析路径仍然是 `apps/cli/node_modules/@forge/core/src/index.ts`，于是启动即失败。

失败不是一行命令的事：`pnpm test`、`pnpm eval`、`pnpm listing` 全都走同一条导入链，
所以“个人版在 Windows 上跑不起来”是**整条路径**，不是单个命令。

## 怎么复现

```bash
node apps/cli/src/main.ts --help
# Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]:
#   Stripping types is currently unsupported for files under node_modules,
#   for "file:///.../apps/cli/node_modules/@forge/core/src/index.ts"
```

## 留下了什么

1. 仓库自带 `tsx`（根 devDependency），它只做**启动垫片**：不产生构建产物，
   不改变 ADR-0011 的零 build。
2. 四个 Windows 入口：`forge.cmd` / `forge.ps1` / `forge-mcp.cmd` / `forge-mcp.ps1`。
   `.cmd` 必须是 CRLF——纯 LF 的批处理会被 cmd.exe 当成一行，注释里的中文也会被当命令执行。
3. `pnpm forge` / `pnpm mcp` / `pnpm bootstrap` / `pnpm listing` / `pnpm demo`
   统一改走 tsx，于是同一份文档在三个平台都能复制。
4. `evals/regressions/regressions.test.ts` 的 0009 钉住上面三件事：
   删掉 tsx、把脚本改回 `node`、或者把 `.cmd` 换成 LF，都会红。
   **它不能在 Linux 上真的执行 `.cmd`**——这一条是成文的边界；它保证的是修复还在，
   而不是“Windows 上一定跑得过”（那需要在 Windows runner 上跑 e2e）。
