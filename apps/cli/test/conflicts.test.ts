/**
 * Phase 5 的**退出条件**，写成可执行的形式。
 *
 *   合成的"新旧状态矛盾" → 100% 进队列、证据正确、**零条被自动应用**；
 *   而"应用"只能由人显式 resolve 触发，且必须带日期与理由。
 *
 * 为什么要跑真的子进程：`link` 到底有没有碰 `assets/`、`--resolve` 缺参数时的退出码、
 * 队列文件的实际形状——这些只有真跑起来才会出错。**"报告里说没写"与"真的没写"
 * 在日志上完全看不出区别**，所以每一条都对着磁盘断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetDirOf, newFrontMatter, renderAssetDocument } from "@forge/schema";
import type { CandidateAssertion } from "@forge/core";
import { CONFLICT_STATUS, candidateIdOf, openInboxLayer, openVault, vaultPaths } from "@forge/store";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "src", "main.ts");

/**
 * @param {string[]} args
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function forge(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [CLI, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { PATH: process.env["PATH"] ?? "" },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function temp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-conflict-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 证据文件：两侧各自指向它里面的一句话（与 golden 集同一套办法）。 */
const EVIDENCE = "file://evidence.md";

/**
 * 造一个"已经有状态"的库：一条 `state` 资产 + 一条要推翻它的候选。
 *
 * @param {string} root
 * @param {{incumbentBody: string; incomingBody: string; subject: string | null}} spec
 * @returns {{assetId: string; assetPath: string; candidateId: string}}
 */
function seed(
  root: string,
  spec: { incumbentBody: string; incomingBody: string; subject: string | null },
): { assetId: string; assetPath: string; candidateId: string } {
  const paths = vaultPaths(root);
  mkdirSync(paths.assets, { recursive: true });
  mkdirSync(paths.inbox, { recursive: true });
  writeFileSync(
    join(root, "evidence.md"),
    `旧的说法：${spec.incumbentBody}\n新的说法：${spec.incomingBody}\n`,
    "utf8",
  );

  const assetId = "state_01M6Q2FD00NVKBVBH80QD63VSX";
  const frontMatter = newFrontMatter("state", assetId, "2026-01-01");
  frontMatter.last_confirmed = "2026-01-01";
  frontMatter.subject = spec.subject;
  frontMatter.sources = [`${EVIDENCE}#t:旧的说法：${spec.incumbentBody}`];
  const dir = join(paths.assets, assetDirOf("state"));
  mkdirSync(dir, { recursive: true });
  const assetPath = `assets/${assetDirOf("state")}/${assetId}.md`;
  writeFileSync(join(root, assetPath), renderAssetDocument(frontMatter, `## 当前状态\n\n${spec.incumbentBody}\n`), "utf8");

  const candidate: CandidateAssertion = {
    type: "state",
    title: "新证据说它变了",
    subject: spec.subject,
    body: spec.incomingBody,
    sources: [`${EVIDENCE}#t:新的说法：${spec.incomingBody}`],
    confidence: 0.3,
    origin: "model",
  };
  const inbox = openInboxLayer(paths);
  const candidateId = candidateIdOf(candidate);
  inbox.put({
    candidate_version: 1,
    candidate_id: candidateId,
    harness: "test",
    model: "test",
    ...candidate,
  });

  return { assetId, assetPath, candidateId };
}

/**
 * @param {string} root
 * @returns {string[]} 每一条资产的字节（用来断言"一个字节都没动"）
 */
function assetBytes(root: string): string[] {
  const assetsRoot = join(root, "assets");
  if (!existsSync(assetsRoot)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(readFileSync(full, "utf8"));
    }
  };
  walk(assetsRoot);
  return out;
}

/**
 * @param {string} root
 * @returns {Array<Record<string, any>>}
 */
function queue(root: string): Array<Record<string, any>> {
  const dir = join(root, "_conflicts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, any>);
}

test("forge link：合成的矛盾 100% 进队列，而 **assets/ 一个字节都没动**", () => {
  const vault = temp();
  try {
    seed(vault.root, {
      incumbentBody: "索引层用本地文件。",
      incomingBody: "索引层改用 node:sqlite 了。",
      subject: "索引层的存储后端",
    });
    const before = assetBytes(vault.root);

    const result = forge(["link", "--vault", vault.root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✓ 冲突：1 条进队列/);
    assert.match(result.stdout, /永不自动应用/);

    const records = queue(vault.root);
    assert.equal(records.length, 1, "该进队列的必须进");
    const record = records[0];
    assert.equal(record?.["status"], CONFLICT_STATUS.OPEN);
    assert.equal(record?.["basis"], "subject-rule");
    assert.equal(record?.["evidence"].length, 2, "两侧的证据都要在（新证据侧在前）");
    assert.equal(record?.["resolution"], null, "没有人判过它，所以记录里不该有任何决议");

    assert.deepEqual(assetBytes(vault.root), before, "`forge link` **不许**碰 assets/");
  } finally {
    vault.cleanup();
  }
});

test("forge link 是幂等的：同一组矛盾跑两次，队列还是一条", () => {
  const vault = temp();
  try {
    seed(vault.root, {
      incumbentBody: "部署方式是单机进程。",
      incomingBody: "现在用容器部署。",
      subject: "部署方式",
    });
    forge(["link", "--vault", vault.root]);
    const second = forge(["link", "--vault", vault.root]);
    assert.equal(second.status, 0);
    assert.equal(queue(vault.root).length, 1);
    assert.match(second.stdout, /已有 1 条/, "第二次应当报「已经有人看过它了」，而不是再写一条");
  } finally {
    vault.cleanup();
  }
});

test("再确认不是冲突：内容一样（只差排版）时队列里一条都没有", () => {
  const vault = temp();
  try {
    seed(vault.root, {
      incumbentBody: "两周一个版本。",
      incomingBody: "两周一个版本。",
      subject: "发布节奏",
    });
    const result = forge(["link", "--vault", vault.root]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /冲突：0 条进队列/);
    assert.match(result.stdout, /再确认 1 条/);
    assert.equal(queue(vault.root).length, 0);
  } finally {
    vault.cleanup();
  }
});

test("没有题面的 state 候选：不参与判定，而且**被报出来**（安静的失败要变成响声）", () => {
  const vault = temp();
  try {
    seed(vault.root, {
      incumbentBody: "缓存层不引入 Redis。",
      incomingBody: "缓存层换成 Redis 了。",
      subject: null,
    });
    const result = forge(["link", "--vault", vault.root]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /丢弃 1 条/);
    assert.match(result.stdout, /补上题面/);
    assert.equal(queue(vault.root).length, 0);
  } finally {
    vault.cleanup();
  }
});

test("`--resolve replace`：新的一代落盘、旧那代只改 status、记录留下理由", () => {
  const vault = temp();
  try {
    const seeded = seed(vault.root, {
      incumbentBody: "索引层用本地文件。",
      incomingBody: "索引层改用 node:sqlite 了。",
      subject: "索引层的存储后端",
    });
    forge(["link", "--vault", vault.root]);
    const conflictId = queue(vault.root)[0]?.["conflict_id"] as string;

    const result = forge([
      "conflicts",
      "--vault",
      vault.root,
      "--resolve",
      conflictId,
      "--decision",
      "replace",
      "--date",
      "2026-03-01",
      "--confidence",
      "0.9",
      "--rationale",
      "线上确认过就是这个",
    ]);
    assert.equal(result.status, 0, result.stderr);

    // 新的一代
    const docs = openVault(vault.root).assets.scan().docs;
    const states = docs.filter((doc) => doc.frontMatter.type === "state");
    assert.equal(states.length, 2, "两代状态都在库里：不许覆盖掉旧的那一代");
    const fresh = states.find((doc) => doc.frontMatter.id !== seeded.assetId);
    assert.ok(fresh !== undefined);
    assert.equal(fresh.frontMatter.supersedes, seeded.assetId);
    assert.equal(fresh.frontMatter.status, "active");
    assert.equal(fresh.frontMatter.last_confirmed, "2026-03-01");
    assert.equal(fresh.frontMatter.subject, "索引层的存储后端");
    assert.deepEqual(fresh.frontMatter.sources, [`${EVIDENCE}#t:新的说法：索引层改用 node:sqlite 了。`]);

    // 旧的那一代只改了 status
    const old = docs.find((doc) => doc.frontMatter.id === seeded.assetId);
    assert.equal(old?.frontMatter.status, "superseded");
    assert.match(old?.body ?? "", /索引层用本地文件/, "旧那代的正文一个字节都不该动");

    // 记录
    const record = queue(vault.root)[0];
    assert.equal(record?.["status"], CONFLICT_STATUS.RESOLVED);
    assert.equal(record?.["resolution"]?.["rationale"], "线上确认过就是这个");
    assert.equal(record?.["resolution"]?.["applied"]?.["supersedes"], seeded.assetId);
    assert.equal(record?.["resolution"]?.["date"], "2026-03-01");

    // 候选已经变成资产，所以离开了候选区
    assert.equal(openVault(vault.root).inbox.scan().records.length, 0);
  } finally {
    vault.cleanup();
  }
});

test("`--resolve keep` / `defer`：**一个字节都不写资产**，但都留下判决", () => {
  for (const decision of ["keep", "defer"]) {
    const vault = temp();
    try {
      seed(vault.root, {
        incumbentBody: "权限模型是单人模式。",
        incomingBody: "现在有角色了。",
        subject: "权限模型",
      });
      const before = assetBytes(vault.root);
      forge(["link", "--vault", vault.root]);
      const conflictId = queue(vault.root)[0]?.["conflict_id"] as string;

      const result = forge([
        "conflicts",
        "--vault",
        vault.root,
        "--resolve",
        conflictId,
        "--decision",
        decision,
        "--date",
        "2026-03-02",
        "--rationale",
        "先不动它",
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(assetBytes(vault.root), before, `${decision} 不该写任何资产`);

      const record = queue(vault.root)[0];
      assert.equal(record?.["resolution"]?.["decision"], decision);
      assert.equal(record?.["status"], decision === "defer" ? CONFLICT_STATUS.DEFERRED : CONFLICT_STATUS.RESOLVED);
    } finally {
      vault.cleanup();
    }
  }
});

test("判一条冲突必须给理由：缺 `--rationale` 就退出 2，且什么都不写", () => {
  const vault = temp();
  try {
    seed(vault.root, {
      incumbentBody: "导出只做 AGENTS.md。",
      incomingBody: "导出还会生成 Skill 目录。",
      subject: "导出格式",
    });
    forge(["link", "--vault", vault.root]);
    const conflictId = queue(vault.root)[0]?.["conflict_id"] as string;
    const before = assetBytes(vault.root);

    const result = forge([
      "conflicts",
      "--vault",
      vault.root,
      "--resolve",
      conflictId,
      "--decision",
      "replace",
      "--date",
      "2026-03-03",
      "--confidence",
      "0.8",
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /rationale/);
    assert.deepEqual(assetBytes(vault.root), before);
    assert.equal(queue(vault.root)[0]?.["status"], CONFLICT_STATUS.OPEN, "没判成，记录必须还是 open");
  } finally {
    vault.cleanup();
  }
});

test("`replace` 早于旧状态的 last_confirmed：拒绝（时间线上会出现新状态从过去生效）", () => {
  const vault = temp();
  try {
    seed(vault.root, {
      incumbentBody: "日志保留 30 天。",
      incomingBody: "日志保留 90 天。",
      subject: "日志保留",
    });
    forge(["link", "--vault", vault.root]);
    const conflictId = queue(vault.root)[0]?.["conflict_id"] as string;

    const result = forge([
      "conflicts",
      "--vault",
      vault.root,
      "--resolve",
      conflictId,
      "--decision",
      "replace",
      "--date",
      "2025-01-01",
      "--confidence",
      "0.8",
      "--rationale",
      "手滑写了个过去的日期",
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /last_confirmed/);
    assert.equal(queue(vault.root)[0]?.["status"], CONFLICT_STATUS.OPEN);
  } finally {
    vault.cleanup();
  }
});

test("同一个 ID 判两次：第二次被拒绝（记录不改写历史）", () => {
  const vault = temp();
  try {
    seed(vault.root, {
      incumbentBody: "敏感度只分三级。",
      incomingBody: "敏感度分成五级了。",
      subject: "敏感度分级",
    });
    forge(["link", "--vault", vault.root]);
    const conflictId = queue(vault.root)[0]?.["conflict_id"] as string;
    const args = [
      "conflicts",
      "--vault",
      vault.root,
      "--resolve",
      conflictId,
      "--decision",
      "keep",
      "--date",
      "2026-03-04",
      "--rationale",
      "旧的仍然成立",
    ];
    assert.equal(forge(args).status, 0);
    const again = forge(args);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /已经判过/);
  } finally {
    vault.cleanup();
  }
});
