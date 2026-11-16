/**
 * 冲突判定的测试 —— 尤其那三条**结构性**的性质（ADR-0027）：
 *
 * 1. **输出里没有"应用"这一档**：判定只出候选 + 证据（形状上就没有可执行的东西）。
 * 2. **证据两侧齐全且可解析**，站不住的整条丢弃并记账。
 * 3. **模型只能加，不能减**——规则查到的一条都不许被模型的输出消掉。
 *
 * 还有一条容易被漏掉的判据：**"已经确认过"不是"冲突"**。
 * 新证据把同一件事再说一遍，该进的是"可以刷新 last_confirmed"那一档。
 * 这个仓库吃过一次同形状的教训（`evals/regressions/0003`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFLICT_BASIS,
  CONFLICT_KINDS,
  adoptModelConflicts,
  conflictKeyOf,
  detectConflicts,
  judgeConflicts,
  missingAfterAdoption,
  proposeModelConflicts,
  type AssetRef,
  type CandidateAssertion,
  type ConflictCandidate,
  type ConflictJudge,
} from "../src/index.ts";

const SPAN_NEW = "src://src_01M6Q2FD00P3EVALGATE000000#k:conv/msg_09";
const SPAN_OLD = "src://src_01M6Q2FD00P3EVALGATE000000#k:conv/msg_01";

/**
 * @param {Partial<CandidateAssertion>} [overrides]
 * @returns {CandidateAssertion}
 */
function candidate(overrides: Partial<CandidateAssertion> = {}): CandidateAssertion {
  return {
    type: "state",
    title: "存储层换成了 SQLite",
    subject: "索引层的存储后端",
    body: "## 当前状态\n\n用 node:sqlite。",
    sources: [SPAN_NEW],
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
    sources: [SPAN_OLD],
    status: "active",
    body: "## 当前状态\n\n用 JSON 文件。",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 主判据：同题面 + 内容不同
// ─────────────────────────────────────────────────────────────────────────────

test("冲突：同一个题面、内容不同 → 一条候选，两侧证据齐全且排序过", () => {
  const judgement = detectConflicts({ candidates: [candidate()], assets: [asset()] });
  assert.equal(judgement.conflicts.length, 1);

  const conflict = judgement.conflicts[0];
  assert.ok(conflict !== undefined);
  assert.equal(conflict.kind, CONFLICT_KINDS.STATE_CONTRADICTS);
  assert.equal(conflict.basis, CONFLICT_BASIS.SUBJECT_RULE);
  assert.equal(conflict.linkKey, "state#索引层的存储后端");
  // 新证据侧在前，两侧都在，且排序（R6）。
  assert.deepEqual(conflict.evidence, [SPAN_NEW, SPAN_OLD]);
  assert.equal(conflict.incumbent.assetId, "state_01M6Q2FD00NVKBVBH80QD63VSX");
  assert.equal(conflict.incoming.title, "存储层换成了 SQLite");
  assert.match(conflict.why, /内容不同/);
});

test("冲突的键是内容寻址的：同一组矛盾重跑得到同一个键（队列不会长第二条）", () => {
  const first = detectConflicts({ candidates: [candidate()], assets: [asset()] }).conflicts[0];
  const second = detectConflicts({ candidates: [candidate()], assets: [asset()] }).conflicts[0];
  assert.equal(first?.key, second?.key);
  assert.equal(first?.key, conflictKeyOf("state#索引层的存储后端", "state_01M6Q2FD00NVKBVBH80QD63VSX", [SPAN_NEW]));

  // 换一处新证据 = 另一条矛盾：它确实该被单独审理。
  const other = detectConflicts({
    candidates: [candidate({ sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:conv/msg_11"] })],
    assets: [asset()],
  }).conflicts[0];
  assert.notEqual(first?.key, other?.key);
});

test("**再确认不是冲突**：归一化后内容相同 → 进 refreshes，不进队列（regressions/0003 的同款）", () => {
  const judgement = detectConflicts({
    candidates: [candidate({ body: "## 当前状态\n\n用 JSON   文件。\n" })],
    assets: [asset({ body: "## 当前状态\n\n用 JSON 文件。" })],
  });
  assert.equal(judgement.conflicts.length, 0, "同一件事被再说一遍不该制造一条待办");
  assert.equal(judgement.refreshes.length, 1);
  assert.match(judgement.refreshes[0]?.why ?? "", /再/);
});

test("**章节标题不是值**：两侧只差模板骨架时是再确认，不是冲突（ADR-0032）", () => {
  // 这一条的来历是**真实撞上的**，不是预防性的（`evals/regressions/0005`）：
  // 资产那一侧带模板强制的 `## 当前状态`，候选那一侧是一句话——形状本来就不一样。
  // 只折叠空白的话，"同一件事被再说一遍"每一次都会被判成内容不同，队列被噪音淹掉。
  const judgement = detectConflicts({
    candidates: [candidate({ body: "用 JSON 文件。" })],
    assets: [asset({ body: "## 当前状态\n\n用 JSON 文件。\n" })],
  });
  assert.equal(judgement.conflicts.length, 0, "标题是模板的骨架，不是这条状态说的那件事");
  assert.equal(judgement.refreshes.length, 1);

  // 反例：剥标题**不许**把真正的内容差异也一起吃掉。
  // 一条"什么都算相同"的归一化能让上面那句全绿，同时让整个冲突判定失效。
  const real = detectConflicts({
    candidates: [candidate({ body: "用 node:sqlite。" })],
    assets: [asset({ body: "## 当前状态\n\n用 JSON 文件。\n" })],
  });
  assert.equal(real.conflicts.length, 1, "正文不同就是不同——剥标题不能顺手把内容也折叠掉");

  // 反例二：标题**里面的字**也算内容。两侧标题不同、正文相同时仍是同一个值
  // （标题被剥掉），但正文里出现的 `#` 不在行首时不该被当成标题。
  const inline = detectConflicts({
    candidates: [candidate({ body: "字段名是 #region，值用 JSON 文件。" })],
    assets: [asset({ body: "## 当前状态\n\n用 JSON 文件。\n" })],
  });
  assert.equal(inline.conflicts.length, 1, "行内的 `#` 不是标题，剥的是行首的 ATX 标题");
});

test("只有 `state` 会产生冲突：decision / event / rule 一律不参与", () => {
  for (const type of ["decision", "event", "rule"] as const) {
    const judgement = detectConflicts({
      candidates: [candidate({ type })],
      assets: [asset({ type })],
    });
    assert.equal(judgement.conflicts.length, 0, `${type} 不该产生冲突`);
    assert.equal(judgement.dropped.length, 0, `${type} 不该被记成"丢弃"——它是本来就不适用`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 现状只认 active：被取代的那一代不再是"现在的事实"
// ─────────────────────────────────────────────────────────────────────────────

test("已被取代的旧状态**不**产生冲突（否则同一次矛盾会在每一代旧状态上重复报）", () => {
  const judgement = detectConflicts({
    candidates: [candidate()],
    assets: [asset({ status: "superseded" })],
  });
  assert.equal(judgement.conflicts.length, 0);
  assert.equal(judgement.refreshes.length, 0);
});

test("同一个题面有两条 active：报**旁注**，不是安静地只挑一条", () => {
  const judgement = detectConflicts({
    candidates: [candidate()],
    assets: [asset(), asset({ id: "state_01M6Q2FD00Z52A681X6FHS62G7", path: "assets/state/state_01M6Q2FD00Z52A681X6FHS62G7.md" })],
  });
  assert.equal(judgement.conflicts.length, 2, "两条 active 各报一条：人要知道有两处要收拾");
  assert.equal(judgement.notes.length, 1);
  assert.match(judgement.notes[0] ?? "", /2 条 active 状态/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 证据：两侧齐全、可解析；站不住就丢，并且说出来
// ─────────────────────────────────────────────────────────────────────────────

test("新证据侧没有出处 → 丢弃并记账（一条核实不了的矛盾不许进队列）", () => {
  const judgement = detectConflicts({ candidates: [candidate({ sources: [] })], assets: [asset()] });
  assert.equal(judgement.conflicts.length, 0);
  assert.equal(judgement.dropped.length, 1);
  assert.match(judgement.dropped[0]?.reason ?? "", /没有出处/);
});

test("现有状态侧没有出处 → 丢弃并记账（它是「现在的样子」，但没东西能证明它）", () => {
  const judgement = detectConflicts({ candidates: [candidate()], assets: [asset({ sources: [] })] });
  assert.equal(judgement.conflicts.length, 0);
  assert.equal(judgement.dropped.length, 1);
  assert.match(judgement.dropped[0]?.reason ?? "", /没有出处/);
});

test("span 语法不合法 → 丢弃，不是「带着坏证据进队列」（ADR-0009）", () => {
  const judgement = detectConflicts({
    candidates: [candidate({ sources: ["不是 span"] })],
    assets: [asset()],
  });
  assert.equal(judgement.conflicts.length, 0);
  assert.equal(judgement.dropped.length, 1);
  assert.match(judgement.dropped[0]?.reason ?? "", /不是合法 span/);
});

test("state 候选没有题面 → 不参与判定，而且**必须被报出来**（安静的那一边才危险）", () => {
  const judgement = detectConflicts({ candidates: [candidate({ subject: null })], assets: [asset()] });
  assert.equal(judgement.conflicts.length, 0);
  assert.equal(judgement.dropped.length, 1);
  assert.match(judgement.dropped[0]?.reason ?? "", /不参与冲突判定/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 模型只能加，不能减
// ─────────────────────────────────────────────────────────────────────────────

/** 一台"什么都觉得矛盾"的模型。 */
const eagerJudge: ConflictJudge = {
  id: "eager-probe",
  propose: () => ["它们其实说的是同一件事（探针恒这么答）"],
};

test("模型只能追加：题面不同的对子规则看不见，模型说了才进队列", () => {
  const assets = [asset(), asset({ id: "state_01M6Q2FD00Z52A681X6FHS62G7", path: "assets/state/x.md", subject: "部署环境" })];
  const ruled = detectConflicts({ candidates: [candidate()], assets });
  assert.equal(ruled.conflicts.length, 1, "规则只管题面相同的那条");

  const adopted = judgeConflicts({ candidates: [candidate()], assets, judge: eagerJudge });
  assert.equal(adopted.conflicts.length, 2);
  assert.equal(adopted.conflicts.some((conflict) => conflict.basis === CONFLICT_BASIS.MODEL_PROPOSED), true);
  assert.deepEqual(missingAfterAdoption(ruled, adopted), [], "规则查到的那条必须还在");
});

test("自证：把规则查到的那条从采纳结果里删掉 —— 必须被抓住（模型不许有否决权）", () => {
  const assets = [asset()];
  const ruled = detectConflicts({ candidates: [candidate()], assets });

  const mutated = adoptModelConflicts(ruled, proposeModelConflicts([candidate()], assets, eagerJudge));
  const suppressed: typeof mutated = { ...mutated, conflicts: [] };
  const lost = missingAfterAdoption(ruled, suppressed);
  assert.equal(lost.length, 1);
  assert.equal(lost[0], ruled.conflicts[0]?.key);
});

test("模型提议的证据同样要站得住：现有状态没有出处时不追加", () => {
  const assets = [asset({ sources: [], subject: "部署环境" })];
  const proposed = proposeModelConflicts([candidate()], assets, eagerJudge);
  assert.deepEqual(proposed, []);
});

test("模型提议的候选带 `basis: model-proposed`（人核对时要知道这是猜的还是查的）", () => {
  const assets = [asset({ subject: "部署环境" })];
  const proposed = proposeModelConflicts([candidate()], assets, eagerJudge);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]?.basis, CONFLICT_BASIS.MODEL_PROPOSED);
});

// ─────────────────────────────────────────────────────────────────────────────
// 确定性
// ─────────────────────────────────────────────────────────────────────────────

test("判定的输出与输入顺序无关（R6）", () => {
  const first = candidate({ title: "甲", sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:a/1"] });
  const second = candidate({ title: "乙", sources: ["src://src_01M6Q2FD00P3EVALGATE000000#k:a/2"] });
  const targets = [asset(), asset({ id: "state_01M6Q2FD00Z52A681X6FHS62G7", path: "assets/state/b.md" })];

  const forward = detectConflicts({ candidates: [first, second], assets: targets });
  const backward = detectConflicts({ candidates: [second, first], assets: [...targets].reverse() });

  assert.deepEqual(
    forward.conflicts.map((conflict) => conflict.key),
    backward.conflicts.map((conflict) => conflict.key),
  );
  assert.deepEqual(forward.notes, backward.notes);
});

test("判定结果里没有任何字段能表达「该改成什么」（ADR-0027 判据 1 的形状检查）", () => {
  const conflict = detectConflicts({ candidates: [candidate()], assets: [asset()] }).conflicts[0] as ConflictCandidate;
  const keys = Object.keys(conflict).sort();
  assert.deepEqual(keys, [
    "basis",
    "evidence",
    "incoming",
    "incumbent",
    "key",
    "kind",
    "linkKey",
    "why",
  ]);
});
