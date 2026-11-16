@echo off
rem Windows entry point for the stdio MCP server (docs/personal.md, iteration 1).
rem Configuration can use one stable command on every client:
rem   cmd /c "<repo>\forge-mcp.cmd" --vault <dir>
rem stdout carries protocol messages only; diagnostics go to stderr.
setlocal
set "FORGE_ROOT=%~dp0"
node "%FORGE_ROOT%node_modules\tsx\dist\cli.mjs" "%FORGE_ROOT%apps\mcp\src\main.ts" %*
