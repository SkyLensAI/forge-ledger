/**
 * 抽取流水线的测试 —— 包括那条**真实出过的 bug**（R7）。
 *
 * 这里钉住的是一条很容易再犯、而且症状极具迷惑性的错误：
 * **把多个来源的候选合起来，对着一个"合并输入"去判出处。**
 *
 * 症状不是崩溃，是"模型抽出来的东西全被丢光"，而报告里每一条的理由
 * 看起来都很有道理（"引用了没看见过的来源"）。一个只看日志的人
 * 会去查模型，而问题在编排里。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACTION_HARNESS, type Model, type ModelRequest } from "@forge/core";
import { newFrontMatter, renderAssetDocument } from "@forge/schema";
import { openVault } from "../src/index.ts";

function temp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "forge-extract-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 每段导入产出两条事件、来自两个来源。 */

/**
 * 一台"诚实"的模型：把请求里出现的**每一条**事件键都原样引回去。
 *
 * 这比写死键更结实——它看着题回答，所以换了来源也不会变成编造，
 * 于是"候选全被丢光"只可能来自编排，不可能来自模型。
 */
const echoModel: Model = {
  id: "echo",
  complete(request: ModelRequest) {
    const keys = [...request.user.matchAll(/^### (.+)$/gm)].map((match) => match[1] ?? "");
    const sourceId = /^来源 ID：(.+)$/m.exec(request.user)?.[1] ?? "";
    return {
      text: JSON.stringify({
        assertions: keys.map((key) => ({
          type: "state",
          title: `现状 ${key}`,
          body: "正文",
          sources: [`src://${sourceId}#k:${key}`],
          confidence: 0.5,
        })),
      }),
    };
  },
};

/**
 * 两个来源的合成输入：按官方导出的形状写，直接调 `importText`——
 * 这条用例测的是编排，不是解析。
 *
 * @param {string} root
 * @returns {void}
 */
function seedTwoSources(root: string): void {
  const vault = openVault(root);
  for (const [name, marker] of [
    ["conv_a", "甲"],
    ["conv_b", "乙"],
  ] as const) {
    vault.importText(
      JSON.stringify({
        export_version: 1,
        exported_by: "test-fixture",
        conversations: [
          {
            id: name,
            title: `${marker}来源`,
            messages: [
              {
                id: "msg_0001",
                sender: "user",
                created_at: "2026-01-01T00:00:00Z",
                text: `这是${marker}来源里的一句话，长度足够。`,
              },
            ],
          },
        ],
      }),
      { originalName: `${name}.json` },
    );
  }
}

test("多个来源：逐来源判出处，候选一条都不许被误判成编造（regressions/0002）", () => {
  const run = temp();
  try {
    seedTwoSources(run.root);
    const vault = openVault(run.root);

    const inputs = vault.inputs();
    assert.equal(inputs.length, 2, "两个来源应当各有一段输入");

    const extracted = vault.extract({ model: echoModel });
    assert.deepEqual(extracted.failures, []);
    assert.equal(extracted.units.length, 2);
    assert.equal(extracted.guard.rejected.length, 0, "没有一条候选该被拒绝");
    assert.equal(extracted.guard.inboxed.length, 2);
    assert.equal(extracted.guard.admitted.length, 0, "模型产出永远不进 assets/");

    // 每一条候选的出处都必须指向**它自己那个来源**。
    for (const decision of extracted.guard.inboxed) {
      const source = decision.candidate.sources[0] ?? "";
      const unit = extracted.units.find((candidateUnit) => candidateUnit.input.sourceId.includes(source.split("//")[1]?.split("#")[0] ?? "?"));
      assert.ok(unit !== undefined, `候选的出处对不上任何一段输入：${source}`);
    }

    const written = vault.recordCandidates(extracted);
    assert.equal(written.written.length, 2);
    assert.equal(written.duplicates, 0);
    assert.deepEqual(written.skippedExisting, []);

    const scan = vault.inbox.scan();
    assert.equal(scan.records.length, 2);
    assert.equal(scan.invalid.length, 0);
    for (const record of scan.records) {
      assert.equal(record.origin, "model");
      assert.equal(record.confidence, 0.3, "模型说 0.5，入库按 0.3 起算");
      assert.equal(record.harness, EXTRACTION_HARNESS);
      assert.equal(record.model, "echo");
    }
  } finally {
    run.cleanup();
  }
});

test("抽取失败时报告里说得清是哪个来源，而且不落盘", () => {
  const run = temp();
  try {
    seedTwoSources(run.root);
    const vault = openVault(run.root);

    const broken: Model = {
      id: "broken",
      complete() {
        throw new Error("端点 500");
      },
    };
    const extracted = vault.extract({ model: broken });
    assert.equal(extracted.failures.length, 2);
    assert.equal(extracted.units.length, 0);
    assert.equal(extracted.guard.inboxed.length, 0);
    for (const failure of extracted.failures) assert.ok(failure.sourceId.startsWith("src_"));
  } finally {
    run.cleanup();
  }
});

test("已经有资产指着同一处出处时，候选不再重复落盘", () => {
  const run = temp();
  try {
    seedTwoSources(run.root);
    const vault = openVault(run.root);

    const extracted = vault.extract({ model: echoModel });
    vault.recordCandidates(extracted);

    // 手工把其中一条候选"确认"成资产的样子：同一类型、同一出处。
    const target = extracted.guard.inboxed[0]?.candidate;
    assert.ok(target !== undefined);
    const frontMatter = newFrontMatter(target.type, `state_${"0".repeat(26)}`, "2026-11-06");
    frontMatter.sources = [...target.sources];
    vault.assets.writeAuthored(
      {
        path: `assets/state/state_${"0".repeat(26)}.md`,
        frontMatter,
        body: "## 当前状态\n\n手写的。\n",
        raw: renderAssetDocument(frontMatter, "## 当前状态\n\n手写的。\n"),
      },
      {
        at: "2026-11-01T00:00:00.000Z",
        actor: "test-fixture",
        kind: "asset-promoted",
        subject: frontMatter.id,
        detail: { why: "「同一处出处」测试的夹具资产" },
      },
    );

    const again = vault.recordCandidates(vault.extract({ model: echoModel }));
    assert.equal(again.skippedExisting.length, 1);
    assert.equal(again.written.length, 1);
  } finally {
    run.cleanup();
  }
});
