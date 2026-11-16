#!/usr/bin/env node
/**
 * 打开 `demo/index.html`。
 *
 * 为什么不是一句 `open demo/index.html`：Windows 的 `start` 是 cmd 内建命令，
 * macOS / Linux 的打开器又各叫各的。把差异收在这一个小脚本里，README 里的
 * 60 秒路径就只需要一条跨平台命令。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const file = resolve(process.cwd(), "demo", "index.html");
if (!existsSync(file)) {
  console.error("✗ 找不到 demo/index.html：先跑一次 `pnpm demo`。");
  process.exit(1);
}

const url = pathToFileURL(file).href;
const [command, args] =
  process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];

const child = spawn(command, args, { stdio: "ignore", detached: true });
child.on("error", (error) => {
  console.error(`✗ 打不开浏览器（${error.message}）。文件在这里：${url}`);
  process.exitCode = 1;
});
child.unref();
console.log(`→ ${url}`);
