/**
 * 探针的自证 —— **只会变绿的检查不是检查**（R8）。
 *
 * 这个文件里的每一条都在问同一个问题：把某一条性质**故意弄坏**之后，
 * 探针会不会红？不会红的那条"检查"只值一行注释。
 *
 * 与 `trust.test.ts` 同一个形状：探针的依赖是可注入的，所以变异不需要改产品代码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFLICT_BASIS,
  judgeConflicts,
  type AssetRef,
  type CandidateAssertion,
} from "../../packages/core/src/index.ts";
import { CONFLICT_STATUS, type ConflictLayer, type ConflictRecord } from "../../packages/store/src/index.ts";
import { evidenceProblems, runConflictProbe, scanForIo } from "./conflict.ts";
import { REPO_ROOT } from "./run.ts";

test("真实状态：合成矛盾集 100% 进队列、证据核对过、资产侧一个字节没动", () => {
  const result = runConflictProbe(REPO_ROOT);
  assert.equal(result.ok, true, [...result.missed, ...result.spurious, ...result.evidenceWrong].join("；"));
  assert.ok(result.cases >= 9, `用例太少：${result.cases}`);
  assert.equal(result.queued, result.expectedQueued, "该进队列的必须全进（Phase 5 的退出条件）");
  // 探针**自己也可能是瞎的**：一条证据都没核对过的全绿不算数。
  assert.ok(result.evidenceChecked > 0, "一条证据都没核对过时，这次检查不成立");
  assert.deepEqual(result.assetsTouched, []);
  assert.deepEqual(result.ioViolations, []);
});

test("变异：判定把规则查到的冲突丢掉（模型有了一票否决）—— 探针必须报红", () => {
  const veto: typeof judgeConflicts = (input) => {
    const ruled = judgeConflicts(input);
    // 模拟"模型说不是冲突，于是规则那条也不报了"。
    return { ...ruled, conflicts: [] };
  };
  const result = runConflictProbe(REPO_ROOT, { judge: veto });
  assert.equal(result.ok, false, "一个什么都不报的判定居然通过了");
  assert.ok(result.missed.length > 0);
  assert.match(result.missed.join("；"), /期望/);
});

test("变异：落盘实现顺手把新状态写进资产 —— 探针必须报红（E9）", () => {
  const autoApply: typeof import("../../packages/store/src/index.ts").writeConflicts = (layer, judgement) => {
    // 这就是 ADR-0027 选项 2 那个口子的形状：判定完"低风险的那一档"自己应用掉。
    for (const conflict of judgement.conflicts) {
      conflict.incumbent.asset.body = conflict.incoming.value;
    }
    return { written: [], existing: [] };
  };
  const result = runConflictProbe(REPO_ROOT, { write: autoApply });
  assert.equal(result.ok, false, "一个会自动应用冲突的实现居然通过了");
  assert.ok(result.assetsTouched.length > 0);
  assert.match(result.assetsTouched.join("；"), /判定 → 落队列/);
});

test("变异：落盘实现漏写了一条（队列记录数与候选数对不上）—— 探针必须报红", () => {
  const lossy: typeof import("../../packages/store/src/index.ts").writeConflicts = (layer, judgement, context) => {
    const first = judgement.conflicts[0];
    const entry = first === undefined ? undefined : context.get(first.key);
    if (first !== undefined && entry !== undefined) {
      layer.put({
        conflict_version: 1,
        conflict_id: "conf_forced",
        status: CONFLICT_STATUS.OPEN,
        kind: first.kind,
        basis: first.basis,
        link_key: first.linkKey,
        subject: entry.subject,
        incumbent: entry.incumbent,
        incoming: { label: "", value: "", sources: [], candidate_id: "", origin: "model" },
        evidence: first.evidence,
        why: first.why,
        before: { value: "", sources: [] },
        resolution: null,
      } satisfies ConflictRecord);
    }
    return { written: [], existing: [] };
  };
  const result = runConflictProbe(REPO_ROOT, { write: lossy });
  assert.equal(result.ok, false);
  assert.match(result.assetsTouched.join("；"), /对不上/);
});

test("变异：判定模块里出现 IO —— 探针必须报红（有能力写，就只差一次代码评审）", () => {
  const withIo = (relative: string): string | null =>
    relative.endsWith("conflict.ts") ? 'import { writeFileSync } from "node:fs";\n' : "export const ok = 1;\n";
  const violations = scanForIo(withIo);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /文件系统/);
});

test("变异：时钟进了判定模块 —— 同样报红（确定性是 R6）", () => {
  const withClock = (relative: string): string | null =>
    relative.endsWith("link.ts") ? "const now = Date.now();\n" : "export const ok = 1;\n";
  const violations = scanForIo(withClock);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /时钟/);
});

test("扫描器读不到源码时报「无法校验」，而不是静默通过（ADR-0009 的同一条区分）", () => {
  const violations = scanForIo(() => null);
  assert.equal(violations.length, 2, "两个判定模块都读不到，就该有两条");
  assert.match(violations[0] ?? "", /无法校验/);
});

test("证据的定义：只解析得到不够，锚点必须**指向它声称的那句话**", () => {
  const resolvedIndex = {
    lookup: (canonicalSpan: string) => ({ kind: "resolved" as const, excerpt: `别处的原文 ${canonicalSpan}` }),
  };
  // 反例：锚点指向的是另一句话——这种错误看起来完全正常，而它把两侧写反了。
  const swapped = evidenceProblems(
    "cf-x·incoming",
    "现在用容器部署。",
    ["file://evals/fixtures/conflict-scenarios.md#t:部署方式是单机进程，不做容器化。"],
    resolvedIndex,
  );
  assert.equal(swapped.length, 1, `解析得到不该算通过，实际：${JSON.stringify(swapped)}`);
  assert.match(swapped[0] ?? "", /指向它声称的那句话/);

  // 反例二：连解析都做不到时，两条问题一起报（修法不同）。
  const unresolvedIndex = { lookup: () => ({ kind: "unresolved" as const, reason: "目标里找不到" }) };
  const broken = evidenceProblems(
    "cf-x·incoming",
    "现在用容器部署。",
    ["file://evals/fixtures/conflict-scenarios.md#t:这句话在文件里不存在"],
    unresolvedIndex,
  );
  assert.equal(broken.length, 2);
  assert.match(broken[0] ?? "", /解析不到/);
  assert.match(broken[1] ?? "", /指向它声称的那句话/);

  // 正例：锚点就是那句话。
  assert.deepEqual(
    evidenceProblems(
      "cf-x·incoming",
      "部署方式是单机进程，不做容器化。",
      ["file://evals/fixtures/conflict-scenarios.md#t:部署方式是单机进程，不做容器化。"],
      resolvedIndex,
    ),
    [],
  );
});

test("探针自己：`judgeConflicts` 在没有模型接缝时也跑得出规则的那一条", () => {
  // 这条钉的是"探针跑的是真的判定"，而不是它自己写的一段仿写。
  const candidate: CandidateAssertion = {
    type: "state",
    title: "t",
    subject: "索引层的存储后端",
    body: "新内容",
    sources: ["file://evals/fixtures/conflict-scenarios.md#t:索引层改用 node:sqlite 了。"],
    confidence: 0.3,
    origin: "model",
  };
  const asset: AssetRef = {
    id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
    path: "assets/state/x.md",
    type: "state",
    subject: "索引层的存储后端",
    sources: ["file://evals/fixtures/conflict-scenarios.md#t:索引层用本地文件，不用数据库。"],
    status: "active",
    body: "旧内容",
  };
  const judgement = judgeConflicts({ candidates: [candidate], assets: [asset] });
  assert.equal(judgement.conflicts.length, 1);
  assert.equal(judgement.conflicts[0]?.basis, CONFLICT_BASIS.SUBJECT_RULE);
});

test("内存队列实现了真的 `ConflictLayer`（探针测的不是一段仿写）", () => {
  // 这条用类型层面之外的办法钉一遍：把 `ConflictLayer` 的五个成员都调一遍。
  const layer: ConflictLayer = {
    scan: () => ({ records: [], invalid: [] }),
    read: () => null,
    put: () => ({ path: "x", created: true }),
    markResolved: () => true,
    remove: () => true,
  };
  assert.equal(layer.scan().records.length, 0);
});
