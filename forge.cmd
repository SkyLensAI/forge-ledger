@echo off
rem Windows entry point (docs/personal.md, iteration 0).
rem Without symlink permission pnpm links workspace packages with junctions on
rem Windows, so @forge/* still resolves through node_modules and Node's native
rem type stripping refuses those .ts files (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
rem tsx is only a launcher shim: it adds no build output and does not change the
rem zero-build rule (ADR-0011).
setlocal
set "FORGE_ROOT=%~dp0"
node "%FORGE_ROOT%node_modules\tsx\dist\cli.mjs" "%FORGE_ROOT%apps\cli\src\main.ts" %*
