/**
 * Phase 2 的**退出条件**，写成可执行的形式。
 *
 *   给一份脱敏会话导出，两次运行产出**逐字节相同**的 `AGENTS.md`；全程不需要 API key。
 *
 * 为什么这条用例要在两个**全新的** vault 上跑，而不是同一个 vault 跑两次：
 * 同一个 vault 跑两次只证明了幂等（那也有价值，但那是另一件事）。
 * 两次都从零开始还能得到同样的字节，才说明**输出里没有时钟、没有随机**
 * ——也就是说确定性是结构性的，不是靠缓存凑出来的。
 *
 * 它跑的是真的子进程，不是函数调用：`--help`、退出码、参数解析都是产品的一部分，
 * 而它们只有当真跑起来才会出错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "src", "main.ts");
const FIXTURE = join(REPO, "evals", "fixtures", "desensitized-export.json");

/**
 * 跑一次 CLI。**不用 JSDoc 注解**：`.ts` 文件里的 `@type` 只是注释，
 * 推断不出来就会退化成隐式 any——而隐式 any 在 `strict` 下是红，
 * 也就是说这条注解写不写都会被发现（这是好事）。
 */
function forge(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("node", [CLI, ...args], {
    cwd: options.cwd ?? REPO,
    encoding: "utf8",
    // 环境里**不带任何 API key**：这条路径根本不该读它。
    // 顺手断言这件事：如果哪天有人往这条链路上挂了个模型调用，这里会先炸。
    // `NODE_OPTIONS` 透传是为了验证用的临时 loader，与产品行为无关。
    env: {
      PATH: process.env["PATH"] ?? "",
      ...(process.env["NODE_OPTIONS"] ? { NODE_OPTIONS: process.env["NODE_OPTIONS"] } : {}),
      ...options.env,
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function temp(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("退出条件：两个全新 vault 各跑一遍，AGENTS.md 逐字节相同", () => {
  const a = temp("forge-a-");
  const b = temp("forge-b-");
  try {
    for (const run of [a, b]) {
      const compiled = forge(["compile", "--vault", join(run.root, "vault"), "--import", FIXTURE]);
      assert.equal(compiled.status, 0, `compile 失败：${compiled.stderr}`);
      assert.match(compiled.stdout, /编译完成/);
      assert.match(compiled.stdout, /事件 \d+ 条（索引层）/);

      const emitted = forge(["emit", "--vault", join(run.root, "vault"), "--out", join(run.root, "out")]);
      assert.equal(emitted.status, 0, `emit 失败：${emitted.stderr}`);
    }

    const first = readFileSync(join(a.root, "out", "AGENTS.md"), "utf8");
    const second = readFileSync(join(b.root, "out", "AGENTS.md"), "utf8");
    assert.equal(first, second, "两次运行产出了不同的字节——说明输出里混进了时钟或随机");
    assert.equal(first.endsWith("\n"), true);
    assert.doesNotMatch(first, /\r/);

    // 两个 vault 的 INDEX.md 与投影目录也必须一致（同一份判定的另一个出口）。
    assert.equal(
      readFileSync(join(a.root, "out", "INDEX.md"), "utf8"),
      readFileSync(join(b.root, "out", "INDEX.md"), "utf8"),
    );
    assert.deepEqual(readdirSync(join(a.root, "out")).sort(), readdirSync(join(b.root, "out")).sort());
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("退出条件：同一个 vault 跑两次，emit --check 判定为一致", () => {
  const run = temp("forge-idem-");
  try {
    const vault = join(run.root, "vault");
    const out = join(run.root, "out");
    assert.equal(forge(["compile", "--vault", vault, "--import", FIXTURE]).status, 0);
    assert.equal(forge(["emit", "--vault", vault, "--out", out]).status, 0);

    const check = forge(["emit", "--vault", vault, "--out", out, "--check"]);
    assert.equal(check.status, 0, `--check 判定不一致：${check.stderr}`);
    assert.match(check.stdout, /逐字节相同/);
  } finally {
    run.cleanup();
  }
});

test("compile 幂等：重复导入同一份导出不产生第二份来源", () => {
  const run = temp("forge-again-");
  try {
    const vault = join(run.root, "vault");
    const first = forge(["compile", "--vault", vault, "--import", FIXTURE]);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /新来源 src_/);

    const second = forge(["compile", "--vault", vault, "--import", FIXTURE]);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /来源已存在 src_/);
    assert.match(second.stdout, /未产生第二份/);
  } finally {
    run.cleanup();
  }
});

test("认不出的格式被拒绝，而不是猜着解析", () => {
  const run = temp("forge-unknown-");
  try {
    const path = join(run.root, "notes.txt");
    writeFileSync(path, "这不是导出文件，只是一段文字", "utf8");
    const result = forge(["compile", "--vault", join(run.root, "vault"), "--import", path]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /认不出这份文件的格式/);
  } finally {
    run.cleanup();
  }
});

test("lint：本仓库的资产全绿（自举路径）", () => {
  const result = forge(["lint", "--repo"]);
  assert.equal(result.status, 0, `本仓库的资产有问题：\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /审核通过/);
});

test("emit 拒绝把坏资产静默漏掉", () => {
  const run = temp("forge-bad-");
  try {
    const vault = join(run.root, "vault");
    mkdirSync(join(vault, "assets", "dec"), { recursive: true });
    writeFileSync(join(vault, "assets", "dec", "broken.md"), "---\nid: 不是合法 ID\n---\n\n# 坏\n", "utf8");

    const result = forge(["emit", "--vault", vault, "--out", join(run.root, "out")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /拒绝 emit/);
    assert.equal(existsSync(join(run.root, "out", "AGENTS.md")), false);
  } finally {
    run.cleanup();
  }
});

test("emit 必须给 --out：投影写哪儿是个决定，不该有默认值", () => {
  const run = temp("forge-noout-");
  try {
    const result = forge(["emit", "--vault", join(run.root, "vault")]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /必须给 --out/);
  } finally {
    run.cleanup();
  }
});

test("未知命令给退出码 2（用法错误）而不是 0", () => {
  const result = forge(["frobnicate"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /未知命令/);
});
