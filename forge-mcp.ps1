# Windows PowerShell / PowerShell 7 上启动 MCP server（与 forge-mcp.cmd 等价）。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $root "node_modules/tsx/dist/cli.mjs") (Join-Path $root "apps/mcp/src/main.ts") @args
exit $LASTEXITCODE
