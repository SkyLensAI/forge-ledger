/**
 * 归并的测试 —— 尤其是那条**不可配置**的界线：模型只能提议，不能并。
 *
 * 与 `guard.test.ts` 同一条思路：归并的关键性质不是"它并得准不准"
 * （那是尺子的事），而是"模型的输出有没有变成一次自动归并"。
 * 所以这个文件里有两条变异用例——把提议塞进 `links`、把提议当实体用——
 * 它们必须被自证函数抓住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LINK_KINDS,
  cleanSubject,
  entitiesOf,
  linkCandidates,
  linkKeyOf,
  normalizeSubjectKey,
  proposedMergesApplied,
  type AssetRef,
  type CandidateAssertion,
  type MergeJudge,
} from "../src/index.ts";

/**
 * @param {Partial<CandidateAssertion>} [overrides]
 * @returns {CandidateAssertion}
 */
function candidate(overrides: Partial<CandidateAssertion> = {}): CandidateAssertion {
  return {
    type: "state",
    title: "一条候选",
    subject: "索引层的存储后端",
    body: "## 当前状态\n\n用 node:sqlite。",
    sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:conv/msg_01"],
    confidence: 0.3,
    origin: "model",
    ...overrides,
  };
}

/**
 * @param {Partial<AssetRef>} [overrides]
 * @returns {AssetRef}
 */
function asset(overrides: Partial<AssetRef> = {}): AssetRef {
  return {
    id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
    path: "assets/state/state_01M6Q2FD00NVKBVBH80QD63VSX.md",
    type: "state",
    subject: "索引层的存储后端",
    sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:conv/msg_00"],
    status: "active",
    body: "## 当前状态\n\n用 node:sqlite。",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 题面键：折叠的是排版，不是语义
// ─────────────────────────────────────────────────────────────────────────────

test("题面的归一化只折叠排版：引号、全角、大小写、首尾标点都不该造出第二个键", () => {
  const forms = ["索引层的存储后端", "  索引层的存储后端。 ", "「索引层的存储后端」", "索引层的存储后端"];
  const keys = new Set(forms.map((form) => normalizeSubjectKey(form)));
  assert.equal(keys.size, 1, `同一个题面的几种写法必须折成一个键，实际：${[...keys].join(" / ")}`);

  assert.equal(normalizeSubjectKey("Postgres"), normalizeSubjectKey("postgres"));
  assert.equal(normalizeSubjectKey("ＡＢＣ"), normalizeSubjectKey("abc"), "NFKC 要把全角折成半角");
});

test("题面键：**不做同义词**，`存储层` 与 `数据库` 是两个键（那是模型提议的事）", () => {
  assert.notEqual(normalizeSubjectKey("存储层"), normalizeSubjectKey("数据库"));
});

test("题面键：超长的题面**拒绝**而不是截断（截断会静默把两件事折成一件）", () => {
  const long = "这件事的名字长到不像一个名字".repeat(6);
  assert.equal(cleanSubject(long), null);
  assert.equal(linkKeyOf("state", long), null);

  // 反例：如果它被截断，下面这两个不同的长题面会折成同一个键。
  const a = `前缀甲${"很长".repeat(40)}`;
  const b = `前缀乙${"很长".repeat(40)}`;
  assert.equal(linkKeyOf("state", a), null);
  assert.equal(linkKeyOf("state", b), null);
});

test("题面键带类型：`state#X` 与 `event#X` 不是同一个实体", () => {
  assert.notEqual(linkKeyOf("state", "同一句话"), linkKeyOf("event", "同一句话"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 三条路：同证据 / 同题面 / 新建
// ─────────────────────────────────────────────────────────────────────────────

test("归并：同一处证据 → 直接链接（证据相同就是同一件事）", () => {
  const shared = "src://src_01M6Q2FD00P3EVALGATE000000#k:conv/msg_00";
  const plan = linkCandidates({
    candidates: [candidate({ sources: [shared] })],
    assets: [asset({ sources: [shared] })],
  });
  assert.equal(plan.links.length, 1);
  assert.equal(plan.links[0]?.kind, LINK_KINDS.SAME_EVIDENCE);
  assert.equal(plan.fresh.length, 0);
});

test("归并：题面相同（证据不同）→ 同一个实体", () => {
  const plan = linkCandidates({ candidates: [candidate()], assets: [asset()] });
  assert.equal(plan.links.length, 1);
  assert.equal(plan.links[0]?.kind, LINK_KINDS.SAME_SUBJECT);
  assert.deepEqual(plan.links[0]?.target, {
    by: "subject",
    key: "state#索引层的存储后端",
    label: "assets/state/state_01M6Q2FD00NVKBVBH80QD63VSX.md",
  });
});

test("归并：没有题面、也没有同一处证据 → **新建**（拿不准就新建）", () => {
  const plan = linkCandidates({
    candidates: [candidate({ subject: null, sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:conv/msg_09"] })],
    assets: [asset()],
  });
  assert.equal(plan.links.length, 0);
  assert.equal(plan.fresh.length, 1);
  assert.equal(plan.fresh[0]?.kind, LINK_KINDS.NEW);
  assert.match(plan.fresh[0]?.why ?? "", /没有可用的题面/);
});

test("归并：同一批里的两条候选引用同一处证据 → 合成一个实体，不是两个", () => {
  const shared = "src://src_01M6Q2FD00P3EVALGATE000000#k:conv/msg_01";
  const plan = linkCandidates({
    candidates: [candidate({ sources: [shared] }), candidate({ sources: [shared], title: "另一条" })],
    assets: [],
  });
  assert.equal(plan.links.length, 1);
  assert.equal(plan.fresh.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 模型只能提议：**不能并**
// ─────────────────────────────────────────────────────────────────────────────

/** 一台"什么都觉得像"的模型：任何一对都给依据。 */
const eagerJudge: MergeJudge = {
  id: "eager-probe",
  propose: () => ["它们说的是同一件事（探针恒这么答）"],
};

test("模型提议的归并进 `proposals`，**一条都不进 `links`**", () => {
  const plan = linkCandidates({
    candidates: [candidate({ subject: "存储层的选型" })],
    assets: [asset({ subject: "索引层的存储后端" })],
    judge: eagerJudge,
  });
  assert.equal(plan.links.length, 0, "模型说像不能变成一次自动归并");
  assert.equal(plan.proposals.length, 1);
  assert.equal(plan.proposals[0]?.kind, LINK_KINDS.PROPOSED_MERGE);
  assert.match(plan.proposals[0]?.why ?? "", /eager-probe/);
  assert.deepEqual(proposedMergesApplied(plan), []);
});

test("自证：把提议塞进 `links` —— 必须被抓住（否则这条性质只是注释）", () => {
  const plan = linkCandidates({
    candidates: [candidate({ subject: "存储层的选型" })],
    assets: [asset({ subject: "索引层的存储后端" })],
    judge: eagerJudge,
  });
  const mutated = { ...plan, links: [...plan.links, ...plan.proposals] };
  const leaked = proposedMergesApplied(mutated);
  assert.equal(leaked.length, 1);
  assert.match(leaked[0] ?? "", /state/);
});

test("提议不参与实体划分：实体只由直接链接与已有资产建起来", () => {
  const plan = linkCandidates({
    candidates: [candidate({ subject: "存储层的选型" })],
    assets: [asset({ subject: "索引层的存储后端" })],
    judge: eagerJudge,
  });
  const entities = entitiesOf(plan, [asset({ subject: "索引层的存储后端" })]);
  const keys = entities.map((entity) => entity.key);
  assert.deepEqual(keys, ["state#索引层的存储后端"], "模型提议的那个题面不该长出一个实体");
  assert.equal(entities[0]?.candidates.length, 0);
  assert.equal(entities[0]?.assets.length, 1);
});

test("没有接缝时只跑规则：拿不准的候选一律新建（不依赖模型的那条路要完整）", () => {
  const plan = linkCandidates({
    candidates: [candidate({ subject: "存储层的选型" })],
    assets: [asset({ subject: "索引层的存储后端" })],
  });
  assert.equal(plan.proposals.length, 0);
  assert.equal(plan.fresh.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 确定性
// ─────────────────────────────────────────────────────────────────────────────

test("归并的输出与输入顺序无关（R6：同一份输入必须打出同样的行）", () => {
  const first = candidate({ sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:a/1"], title: "甲" });
  const second = candidate({ sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:a/2"], title: "乙" });

  const forward = linkCandidates({ candidates: [first, second], assets: [asset()] });
  const backward = linkCandidates({ candidates: [second, first], assets: [asset()] });

  const keys = (plan: ReturnType<typeof linkCandidates>): string[] =>
    [...plan.links, ...plan.fresh, ...plan.proposals].map((decision) => `${decision.kind} ${decision.candidate.title}`);
  assert.deepEqual(keys(forward), keys(backward));
});
