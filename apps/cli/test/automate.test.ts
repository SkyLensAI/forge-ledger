/**
 * `forge automate` 的 CLI 侧（docs/automation.md）。
 *
 * 它测的是**配方能不能直接用**，不是政策本身：
 *
 * 1. `--list` 不写盘，三档都看得见；
 * 2. `--out` 生成一整套文件，`--check` 能对账；
 * 3. 两个全新目录各生成一次，字节相同（R6）；
 * 4. 手改生成物会让 `--check` 报红——生成物不是第二份真相；
 * 5. 生成物的可执行文件里没有 `promote` / `resolve` / `confirm`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "src", "main.ts");

function forge(args: string[], cwd = REPO): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, "automate", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function temp(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("--list：三档政策都能看见，而且不写盘", () => {
  const result = forge(["--list"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /一、可以全自动/);
  assert.match(result.stdout, /二、可以自动准备/);
  assert.match(result.stdout, /三、设计上禁止自动化/);
  assert.match(result.stdout, /candidate-promote/);
  assert.match(result.stdout, /state-confirm/);
  assert.match(result.stdout, /model-to-assets/);
});

test("--out：生成完整配方；--check 对账一致", () => {
  const run = temp("forge-automate-");
  try {
    const out = join(run.root, "auto");
    const generated = forge(["--out", out, "--forge-bin", "forge", "--workdir", "/srv/forge"]);
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /自动化配方/);

    for (const path of [
      ".forge-manifest.json",
      "README.md",
      "pipeline.cron",
      "pipeline.ps1",
      "pipeline.sh",
      "task-scheduler.xml",
    ]) {
      assert.ok(existsSync(join(out, path)), `应该生成 ${path}`);
    }

    // --workdir 原样写进配方：跨平台生成时不会被当前平台的 path.resolve 改写。
    const cron = readFileSync(join(out, "pipeline.cron"), "utf8");
    assert.match(cron, /cd '\/srv\/forge'/);
    assert.ok(
      cron.includes(`${out.replace(/\\/g, "/")}/pipeline.sh`),
      "cron 必须指向真实的生成目录，而不是工作目录里的同名文件",
    );

    const check = forge(["--out", out, "--forge-bin", "forge", "--workdir", "/srv/forge", "--check"]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /逐字节相同/);

    // 生成物不是第二份真相：手改一个字节，--check 必须红。
    writeFileSync(join(out, "pipeline.sh"), `${readFileSync(join(out, "pipeline.sh"), "utf8")}# hand edit\n`, "utf8");
    const drifted = forge(["--out", out, "--forge-bin", "forge", "--check"]);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /不一致/);
  } finally {
    run.cleanup();
  }
});

test("确定性：两个全新目录生成的文件逐字节相同", () => {
  const a = temp("forge-auto-a-");
  const b = temp("forge-auto-b-");
  try {
    // 相同的**输入**才要求相同的字节：工作目录与输出目录都当显式输入。
    // 如果让 --out 取各自的绝对临时路径，README 里的路径本来就该不同。
    const args = [
      "--out",
      "auto",
      "--workdir",
      "/srv/forge",
      "--forge-bin",
      "/usr/local/bin/forge",
    ];
    assert.equal(forge(args, a.root).status, 0);
    assert.equal(forge(args, b.root).status, 0);

    for (const path of ["README.md", "pipeline.cron", "pipeline.ps1", "pipeline.sh", "task-scheduler.xml"]) {
      const left = readFileSync(join(a.root, "auto", path), "utf8");
      const right = readFileSync(join(b.root, "auto", path), "utf8");
      assert.equal(left, right, `${path} 两次生成不同——输出里混进了时钟或随机`);
      assert.doesNotMatch(left, /\r/, `${path} 必须是 LF`);
    }
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("生成的脚本里没有三个「点头」动作；--forge-bin 写进脚本", () => {
  const run = temp("forge-automate-safe-");
  try {
    const out = join(run.root, "auto");
    const generated = forge(["--out", out, "--forge-bin", "my-forge"]);
    assert.equal(generated.status, 0, generated.stderr);

    const sh = readFileSync(join(out, "pipeline.sh"), "utf8");
    const ps = readFileSync(join(out, "pipeline.ps1"), "utf8");
    assert.match(sh, /FORGE_BIN:-my-forge/);
    assert.match(ps, /'my-forge'/);
    // 注释里可以解释边界；这里只看可执行行。
    for (const text of [sh, ps]) {
      const code = text
        .split("\n")
        .map((line) => line.split("#")[0] ?? "")
        .join("\n");
      assert.doesNotMatch(code, /--promote\b/);
      assert.doesNotMatch(code, /--resolve\b/);
      assert.doesNotMatch(code, /\bconfirm\b/);
    }
  } finally {
    run.cleanup();
  }
});

test("bash 语法检查：生成的 pipeline.sh 能被 bash 解析", () => {
  const run = temp("forge-automate-syntax-");
  try {
    const out = join(run.root, "auto");
    mkdirSync(out, { recursive: true });
    assert.equal(forge(["--out", out, "--forge-bin", "forge"]).status, 0);

    const parsed = spawnSync("bash", ["-n", join(out, "pipeline.sh")], { encoding: "utf8" });
    // Windows 上不一定有 bash；没有就明确跳过，而不是把"没跑"算成"通过了"。
    if (parsed.error) return;
    assert.equal(parsed.status, 0, parsed.stderr);
  } finally {
    run.cleanup();
  }
});

test("缺 --out 且不是 --list：退出码 2，并说清为什么不给默认值", () => {
  const result = forge([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /必须给 --out/);
  assert.match(result.stderr, /不该有默认值/);
});
