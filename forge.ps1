# Windows PowerShell / PowerShell 7 入口（docs/personal.md 迭代 0）。
#
# 与 forge.cmd 同源：没有符号链接权限时，pnpm 在 Windows 上用 junction 链接
# workspace 包，Node 的原生类型擦除因此拒绝执行。tsx 只做启动垫片，不改变零 build。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $root "node_modules/tsx/dist/cli.mjs") (Join-Path $root "apps/cli/src/main.ts") @args
exit $LASTEXITCODE
