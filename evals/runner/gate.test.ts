/**
 * 尺子的尺子 —— 判定 eval 闸门的那段逻辑，自己也要能被判红。
 *
 * 为什么这些用例必须在**落地之前**就能跑：eval 闸门的本体是受保护路径，
 * agent 写不了（R2/R3），它要等人工落盘才会第一次执行。
 * 如果这段判定写在闸门脚本里，那么"闸门第一次运行"就发生在它生效的那一刻——
 * 那不是演练，那是赌博。所以判定住在这里（`evals/`，不受保护），
 * 闸门脚本只是一个薄壳。
 *
 * 最要紧的一条是最後一个用例：它跑**真实的**评测，然后断言
 * "当前只因为人工确认没做而红"。它把仓库的真实状态钉在测试里——
 * 而不是让某个人某天盯着 CI 猜"这红的是不是正常"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EVAL_CODES, evaluateEvalGate, formatGateProblems, type GateReport, type GateThresholds } from "./gate.ts";
import { EXTRACTORS, REPO_ROOT, loadThresholds, runEval } from "./run.ts";

/** 用例与阈值的假指纹。真指纹由 `runEval` 算，这里只要"对得上/对不上"两种关系。 */
const CASES_DIGEST = "a".repeat(64);
const THRESHOLDS_DIGEST = "b".repeat(64);
const CONFLICT_DIGEST = "d".repeat(64);

/**
 * Phase 8 探针的"全绿"形状。ADR 数与产物数都不为 0 同样是判据的一部分：
 * 一个什么都没读到的探针能让所有"存在"检查变绿。
 */
const PHASE8_GREEN = {
  ok: true,
  adrCount: 42,
  adrTarget: 30,
  assets: 42,
  demoFiles: 48,
  listingFiles: 52,
  demoDeterministic: true,
  listingDeterministic: true,
  demoFromOwnLibrary: true,
  listingFromOwnLibrary: true,
  listingDraft: true,
  team: {
    eligibility: "deferred",
    paymentSignal: null,
    missing: ["permissions", "concurrency", "sensitivity"],
    violations: [],
  },
  violations: [],
  detail: [],
};

/**
 * 一份"全绿"的假报告。用例只改需要改的那一项——
 * 这样每条断言测的是**一个**变量，而不是一堆默认值凑出来的巧合。
 *
 * @param {Partial<GateReport>} [overrides]
 * @returns {GateReport}
 */
function green(overrides: Partial<GateReport> = {}): GateReport {
  return {
    extractor: "被测实现",
    scores: { precision: 0.9, recall: 0.9, f1: 0.9, cases: 20 },
    threshold: { precision: 0.7, recall: 0.7 },
    verdict: { ok: true, misses: [] },
    review: { status: "confirmed", reviewed_by: "someone", cases_sha256: CASES_DIGEST },
    goldenDigest: CASES_DIGEST,
    thresholdsDigest: THRESHOLDS_DIGEST,
    goldenIssues: [],
    candidateViolations: [],
    // 信任边界探针的"全绿"：0 条违规留存、0 条被判可直接入库、**至少 1 条**进了候选区。
    // 第三条不是凑数：探针一条都没活下来时它自己就是瞎的（见 trust.ts 的第 4 条性质）。
    trust: { ok: true, violationsAfterSanitize: 0, admitted: 0, inboxed: 1, discarded: 6, detail: [] },
    // 冲突探针的"全绿"：该进队列的都进了、证据核对过、资产侧一个字节没动、判定模块里没有 IO。
    // `expectedQueued`/`evidenceChecked` 不为 0 是**判据的一部分**：全为 0 时探针是瞎的
    // （一个什么都不报的实现也能让它全绿，见 conflict.ts 里的同款理由）。
    conflict: {
      ok: true,
      cases: 9,
      expectedQueued: 6,
      queued: 6,
      evidenceChecked: 6,
      missed: [],
      spurious: [],
      evidenceWrong: [],
      assetsTouched: [],
      ioViolations: [],
      goldenIssues: [],
      detail: [],
      review: { status: "confirmed", reviewed_by: "someone", cases_sha256: CONFLICT_DIGEST },
      digest: CONFLICT_DIGEST,
    },
    // 取用探针的"全绿"：没撑破预算、没有预加载、尺子也没瞎。
    // `injected` 不为 0、`irrelevant` 不为 0 同样是**判据的一部分**——
    // 一个"什么都注入不出来"或"什么都算有关"的实现能让预算检查全绿（见 retrieval.ts）。
    retrieval: {
      ok: true,
      corpus: 29,
      queries: 5,
      injected: 12,
      considered: 145,
      irrelevant: 21,
      maxBlockTokens: 900,
      budget: 1200,
      violations: [],
      preloaded: [],
      blind: [],
      goldenIssues: [],
      detail: [],
    },
    // 维护探针的"全绿"：链完整、三种破坏都被抓住、写门拒绝无见证人的写入、
    // 干净语料零发现、只读、可重印、1000 条之后仍然确定且没淹掉信号。
    // `entries` / `caught` / `corpora` / `cleanFindings` 都不为 0 同样是判据的一部分——
    // 一个"什么都没测"的探针能让这三条检查全绿（与另外三个探针同一条理由）。
    maintenance: {
      ok: true,
      audit: {
        ok: true,
        entries: 3,
        kinds: ["source-imported", "asset-promoted", "state-confirmed"],
        cleanChainOk: true,
        caught: ["删一行", "改内容", "换顺序"],
        missed: [],
        unattributedSeen: true,
        refusesWithoutWitness: true,
        detail: [],
      },
      health: {
        ok: true,
        cleanFindings: 0,
        corpora: 11,
        missed: [],
        falsePositives: [],
        readonlyOk: true,
        deterministic: true,
        detail: [],
      },
      scale: { ok: true, assets: 1002, deterministic: true, plantedRotFound: true, detail: [] },
    },
    phase8: PHASE8_GREEN,
    ...overrides,
  };
}

const RATIFIED: GateThresholds = {
  extraction: {
    precision: 0.7,
    recall: 0.7,
    ratified_by: "someone",
    ratified_at: "2026-11-06",
    thresholds_sha256: THRESHOLDS_DIGEST,
  },
};

/**
 * @param {Partial<GateReport>} [overrides]
 * @param {{report?: GateReport, nullReport?: Partial<GateReport>}} [extra]
 * @returns {string[]}
 */
function codes(overrides: Partial<GateReport> = {}, extra: { nullReport?: Partial<GateReport> } = {}): string[] {
  return evaluateEvalGate({
    report: green(overrides),
    // 默认的"空实现"是合格的对照：0 分、不及格。
    nullReport: green({
      extractor: "null",
      scores: { precision: 0, recall: 0, f1: 0, cases: 20 },
      verdict: { ok: false, misses: ["召回率 0.000 < 阈值 0.700"] },
      ...extra.nullReport,
    }),
    thresholds: RATIFIED,
  }).map((problem) => problem.code);
}

test("全绿时不报任何问题（闸门不能天天误报）", () => {
  assert.deepEqual(codes(), []);
});

test("分数没够上阈值 → E1", () => {
  assert.deepEqual(
    codes({ verdict: { ok: false, misses: ["召回率 0.500 < 阈值 0.700"] } }),
    [EVAL_CODES.BELOW_THRESHOLD],
  );
});

test("golden 集没被人工确认 → E2（尺子等于让被测者自己判卷）", () => {
  assert.deepEqual(codes({ review: { status: "proposed", reviewed_by: null } }), [EVAL_CODES.UNREVIEWED]);
});

test("golden 集在确认**之后**被改过 → E2（确认绑的是内容，不是文件名）", () => {
  // 只查"有没有人点过头"，就留下一张能盖在任何后续改动上的橡皮图章——
  // 包括"agent 事后加一条恰好让当前实现变准的用例"。
  assert.deepEqual(codes({ goldenDigest: "c".repeat(64) }), [EVAL_CODES.UNREVIEWED]);
  // 缺指纹（旧格式的确认）同样算没确认，而不是默认放行。
  assert.deepEqual(codes({ review: { status: "confirmed", reviewed_by: "someone" } }), [EVAL_CODES.UNREVIEWED]);
});

test("阈值被人工批准过，但数字改过 → E6", () => {
  const problems = evaluateEvalGate({
    // 文件里现在写的是 0.5/0.5（指纹 c…），而批准记录的是当初那一组（指纹 b…）。
    report: green({ threshold: { precision: 0.5, recall: 0.5 }, thresholdsDigest: "c".repeat(64) }),
    nullReport: green({ scores: { precision: 0, recall: 0, f1: 0, cases: 20 }, verdict: { ok: false, misses: [] } }),
    thresholds: RATIFIED,
  });
  assert.deepEqual(
    problems.map((problem) => problem.code),
    [EVAL_CODES.THRESHOLD_UNRATIFIED],
  );
});

test("阈值没被人工批准 → E6", () => {
  const problems = evaluateEvalGate({
    report: green(),
    nullReport: green({ scores: { precision: 0, recall: 0, f1: 0, cases: 20 }, verdict: { ok: false, misses: [] } }),
    thresholds: { extraction: { precision: 0.7, recall: 0.7, ratified_by: null, ratified_at: null } },
  });
  assert.deepEqual(
    problems.map((problem) => problem.code),
    [EVAL_CODES.THRESHOLD_UNRATIFIED],
  );
});

test("用例自身指不回原文 → E5（分数不可采信，而不是「抽取器不及格」）", () => {
  assert.deepEqual(
    codes({ goldenIssues: ["ext-016：判据的 span 解析不到"] }),
    [EVAL_CODES.GOLDEN_INVALID],
  );
});

test("候选断言越过信任边界 → E3", () => {
  assert.deepEqual(
    codes({
      candidateViolations: [
        { code: "CAND_SPAN_NOT_IN_INPUT", path: "src_x · 候选 #0", message: "编造的出处", fix: "只引用输入里的事件" },
      ],
    }),
    [EVAL_CODES.PROVENANCE],
  );
});

test("**空实现及格 → E4**：这正是 Phase 3 的退出条件", () => {
  const problems = codes({}, { nullReport: { verdict: { ok: true, misses: [] }, scores: { precision: 1, recall: 1, f1: 1, cases: 20 } } });
  assert.deepEqual(problems, [EVAL_CODES.BLIND]);
});

test("E4 的边界：空实现的召回率**恰好等于**阈值也算瞎（`>=` 不是 `>`）", () => {
  const problems = codes({}, { nullReport: { scores: { precision: 0, recall: 0.7, f1: 0, cases: 20 } } });
  assert.deepEqual(problems, [EVAL_CODES.BLIND]);
});

test("E4 的边界：只比阈值低一点就算分得开（这条检查不做主观判断）", () => {
  const problems = codes({}, { nullReport: { scores: { precision: 0, recall: 0.699, f1: 0, cases: 20 } } });
  assert.deepEqual(problems, []);
});

test("多个问题一起报，且输出顺序稳定（报告也要能 diff）", () => {
  const problems = evaluateEvalGate({
    report: green({
      verdict: { ok: false, misses: ["精确率 0.100 < 阈值 0.700"] },
      review: { status: "proposed", reviewed_by: null },
      goldenIssues: ["ext-002：判据的 span 不合法"],
    }),
    nullReport: green({ verdict: { ok: true, misses: [] }, scores: { precision: 0, recall: 1, f1: 0, cases: 20 } }),
    thresholds: RATIFIED,
  });
  assert.deepEqual(problems.map((problem) => problem.code).sort(), [
    EVAL_CODES.BELOW_THRESHOLD,
    EVAL_CODES.BLIND,
    EVAL_CODES.GOLDEN_INVALID,
    EVAL_CODES.UNREVIEWED,
  ].sort());
  assert.deepEqual(formatGateProblems(problems), formatGateProblems([...problems].reverse()));
});

// ─────────────────────────────────────────────────────────────────────────────
// 对着**真实仓库**跑一遍：把当前状态钉在测试里
// ─────────────────────────────────────────────────────────────────────────────

test("真实评测：词法基线及格、空实现不及格，尺子分得开", () => {
  const baseline = EXTRACTORS.get("baseline-lexical");
  const dead = EXTRACTORS.get("null");
  assert.ok(baseline !== undefined && dead !== undefined, "登记表里必须同时有基线与空实现");

  const live = runEval({ repoRoot: REPO_ROOT, extractor: baseline });
  const none = runEval({ repoRoot: REPO_ROOT, extractor: dead });

  assert.equal(live.goldenIssues.length, 0, `尺子自身有问题：\n${live.goldenIssues.join("\n")}`);
  assert.equal(live.candidateViolations.length, 0, "产出必须全部指得回输入里的事件");
  assert.equal(live.verdict.ok, true, `基线没够上阈值：${live.verdict.misses.join("；")}`);
  assert.equal(none.scores.recall, 0);
  assert.equal(none.verdict.ok, false, "空实现必须不及格——否则尺子没有判别力");

  // 阈值必须留有余量：让分数贴着阈值会让一次无关的重构就变红，
  // 于是所有人学会无视它（这也是 evals/thresholds.json 里 why 字段说的那件事）。
  assert.ok(
    live.scores.precision > live.threshold.precision && live.scores.recall > live.threshold.recall,
    `阈值贴着实测分：实测 ${live.scores.precision}/${live.scores.recall}，阈值 ${live.threshold.precision}/${live.threshold.recall}`,
  );
});

test("真实评测：用例数不少于 20 条，且期望断言数大于 0（否则尺子量不到东西）", () => {
  const live = runEval({ repoRoot: REPO_ROOT, extractor: EXTRACTORS.get("baseline-lexical")! });
  assert.ok(live.scores.cases >= 20, `golden 集少于 20 条：实际 ${live.scores.cases}`);
  assert.ok(live.scores.expected > 0);
  // 反例用例（期望为空）必须存在：没有它们，一个"每句话都抽一条"的实现
  // 会拿到满分召回率，而精确率的惩罚又会被正例稀释掉。
  const negatives = live.details.filter((detail) => detail.expected.length === 0);
  assert.ok(negatives.length >= 3, `反例用例少于 3 条：实际 ${negatives.length}`);
});

test("真实状态：人工确认已完成，闸门应当零问题——这句话被写进测试，而不是靠人猜", () => {
  const baseline = EXTRACTORS.get("baseline-lexical");
  assert.ok(baseline !== undefined);
  const thresholds = loadThresholds(REPO_ROOT);
  const report = runEval({ repoRoot: REPO_ROOT, extractor: baseline });
  const problems = evaluateEvalGate({
    report,
    nullReport: runEval({ repoRoot: REPO_ROOT, extractor: EXTRACTORS.get("null")! }),
    thresholds,
  });

  const codesNow = problems.map((problem) => problem.code).sort();
  assert.deepEqual(
    codesNow,
    [],
    `闸门应当零问题。实际：${codesNow.join(",")}\n` +
      "如果这里是 E2/E6，说明 golden 集或阈值被改过之后没有重新确认——" +
      "那不是「闸门坏了」，是确认过期了，去按 evals/README.md 重签。",
  );
  // 确认必须真的落在文件里，而不是靠"我记得点过"。
  assert.equal(report.review.status, "confirmed");
  assert.equal(report.review.cases_sha256, report.goldenDigest);
  assert.equal(thresholds.extraction.thresholds_sha256, report.thresholdsDigest);
  assert.ok(typeof report.review.reviewed_by === "string" && report.review.reviewed_by.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 · 冲突队列（E8 / E9）—— implement2.md 给 P5 的 CI 强制项是"无自动覆盖"
// ─────────────────────────────────────────────────────────────────────────────

test("冲突合成集没被人工确认 → E2（两把尺子共用同一条判据）", () => {
  assert.deepEqual(
    codes({ conflict: { ...green().conflict, review: { status: "proposed", reviewed_by: null } } }),
    [EVAL_CODES.UNREVIEWED],
  );
});

test("冲突合成集在确认**之后**被改过 → E2（确认绑的是内容）", () => {
  assert.deepEqual(codes({ conflict: { ...green().conflict, digest: "e".repeat(64) } }), [EVAL_CODES.UNREVIEWED]);
});

test("该进队列的没进 → E8（Phase 5 退出条件的前半句）", () => {
  assert.deepEqual(
    codes({
      conflict: {
        ...green().conflict,
        ok: false,
        queued: 5,
        missed: ["cf-002：期望 1 条进队列，实际 0 条"],
      },
    }),
    [EVAL_CODES.CONFLICT_QUEUE_INCOMPLETE],
  );
});

test("证据对不上原文 → E8（只查「进没进」会漏掉两侧证据写反了的那种）", () => {
  assert.deepEqual(
    codes({
      conflict: {
        ...green().conflict,
        ok: false,
        evidenceWrong: ["cf-001：证据 file://… 指向的原文里既没有新证据那句话，也没有现状那句话"],
      },
    }),
    [EVAL_CODES.CONFLICT_QUEUE_INCOMPLETE],
  );
});

test("冲突合成集自己坏了（指不回原文）→ E5，而不是 E8（先修用例，再看队列）", () => {
  assert.deepEqual(
    codes({ conflict: { ...green().conflict, ok: false, goldenIssues: ["cf-007：证据解析不到"] } }),
    [EVAL_CODES.GOLDEN_INVALID, EVAL_CODES.CONFLICT_QUEUE_INCOMPLETE],
  );
});

test("有一条冲突被自动应用 → E9（P5 的 CI 强制项：无自动覆盖）", () => {
  // 探针在那种情况下会同时红 E8（因为它自己也判不通过了），所以这里两条一起报——
  // 但 E9 的那一条是**独立**判出来的（见上一条用例）。
  assert.deepEqual(
    codes({
      conflict: {
        ...green().conflict,
        ok: false,
        assetsTouched: ["cf-001：走完「判定 → 落队列」之后资产侧被改动了"],
      },
    }),
    [EVAL_CODES.CONFLICT_QUEUE_INCOMPLETE, EVAL_CODES.CONFLICT_AUTO_APPLIED],
  );
});

test("判定模块里出现了 IO → E9（有能力写，就只差一次代码评审）", () => {
  // 只报 E9、不报 E8：这条检查**不依赖探针自己的 ok**——
  // 探针可以在别处红着，而"判定模块有 IO"这件事必须独立报出来。
  assert.deepEqual(
    codes({ conflict: { ...green().conflict, ioViolations: ["packages/core/src/conflict.ts：引入了文件系统"] } }),
    [EVAL_CODES.CONFLICT_AUTO_APPLIED],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 · 取用（E10 / E11）—— implement2.md 给 P6 的 CI 强制项是"注入预算"
// ─────────────────────────────────────────────────────────────────────────────

test("注入块撑破预算 → E10（P6 的 CI 强制项）", () => {
  assert.deepEqual(
    codes({
      retrieval: {
        ...green().retrieval,
        ok: false,
        violations: ["查询「存储后端」：注入块 1400 token 超过了预算 1200"],
      },
    }),
    [EVAL_CODES.INJECTION_BUDGET],
  );
});

test("尺子瞎了（一条都没注入 / 什么都算有关）→ E10，而不是静默全绿", () => {
  // 这两条与 `E4`（空实现也及格）同源：一个"什么都注入不出来"的实现
  // 能让**所有**预算检查通过——预算检查必须有见证人。
  assert.deepEqual(
    codes({ retrieval: { ...green().retrieval, blind: ["拿 5 个资产标题当查询，一条都没注入"] } }),
    [EVAL_CODES.INJECTION_BUDGET],
  );
  assert.deepEqual(
    codes({ retrieval: { ...green().retrieval, blind: ["每个查询都把整个库判成「有关」"] } }),
    [EVAL_CODES.INJECTION_BUDGET],
  );
});

test("预加载 → E11，而且**不**顺带报 E10（两件事的修法不同）", () => {
  // 这一条是这两个码分开的理由：一个把全库倒出来的实现，
  // 只要预算够大，就不会撑破预算——它**只会**在 E11 上红。
  assert.deepEqual(
    codes({
      retrieval: {
        ...green().retrieval,
        ok: false,
        preloaded: ["查询「存储后端」：注入了 20/29 条（超过 50% 就不是检索，是把库倒出来）"],
      },
    }),
    [EVAL_CODES.PRELOAD],
  );
});

test("取用探针读不出语料 → E5（这次读数不可采信），而不是 E10/E11", () => {
  assert.deepEqual(
    codes({ retrieval: { ...green().retrieval, ok: false, goldenIssues: ["语料里读不动的资产：docs/adr/x.md"] } }),
    [EVAL_CODES.GOLDEN_INVALID],
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 · 维护机器（E12 / E13 / E14）—— implement2.md 给 P7 的 CI 强制项
// 是"审计完整性"；其余两条是"健康检查还看得见吗"与"规模上去之后退化了吗"
// ─────────────────────────────────────────────────────────────────────────────

test("审计断了 / 写门能被绕过 → E12（P7 的 CI 强制项：审计完整性）", () => {
  // 三种坏法各报一次，因为它们防的是三件不同的事：
  // 链是假的、破坏抓不住、"记审计"退化成可选。任意一条都足以让审计没有意义。
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, audit: { ...green().maintenance.audit, ok: false, missed: ["改内容：verify 没报出「内容被改过」"] } } }),
    [EVAL_CODES.AUDIT_GAP],
  );
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, audit: { ...green().maintenance.audit, cleanChainOk: false } } }),
    [EVAL_CODES.AUDIT_GAP],
  );
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, audit: { ...green().maintenance.audit, refusesWithoutWitness: false } } }),
    [EVAL_CODES.AUDIT_GAP],
  );
});

test("干净语料上报了东西（噪音）→ E13 —— 与「该报没报」是两个方向", () => {
  // 这一条最容易被当成小事："多报几条而已"。但**长期挂着的红等于没有红**，
  // 而这份报告的全部价值就是"红的时候有人信"。
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, health: { ...green().maintenance.health, ok: false, cleanFindings: 7, falsePositives: ["「干净」不该报 HEALTH_ORPHAN"] } } }),
    [EVAL_CODES.HEALTH_BLIND],
  );
});

test("某组腐烂没被认出来 → E13（瞎了，与噪音相反的那个方向）", () => {
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, health: { ...green().maintenance.health, ok: false, missed: ["「替换写了一半」应该报 HEALTH_SILENT_SUPERSESSION"] } } }),
    [EVAL_CODES.HEALTH_BLIND],
  );
});

test("健康检查改了库（或者报告不能重印）→ E13", () => {
  // "只读"不是风格：一个会顺手修东西的健康检查会让库永远看起来是新鲜的，
  // 而**新鲜度任务的全部价值就是让「过期」被看见**（ADR-0036）。
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, health: { ...green().maintenance.health, readonlyOk: false } } }),
    [EVAL_CODES.HEALTH_BLIND],
  );
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, health: { ...green().maintenance.health, deterministic: false } } }),
    [EVAL_CODES.HEALTH_BLIND],
  );
});

test("规模上去之后退化了 → E14（P7 退出条件的结构性替身）", () => {
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, scale: { ...green().maintenance.scale, plantedRotFound: false, ok: false } } }),
    [EVAL_CODES.SCALE_DEGRADED],
  );
  assert.deepEqual(
    codes({ maintenance: { ...green().maintenance, scale: { ...green().maintenance.scale, deterministic: false, ok: false } } }),
    [EVAL_CODES.SCALE_DEGRADED],
  );
});

test("维护探针全绿时**不许**报 E12/E13/E14（只会变红的检查不是检查）", () => {
  assert.deepEqual(codes({}), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 · 自举 / 团队版 / 上架 / demo（E15 / E16）
// ─────────────────────────────────────────────────────────────────────────────

test("ADR 跌破 30 条、产物不可重生成、demo 不是自己的库 → E15", () => {
  // 四个方向各测一次。它们防的是四件不同的事：
  // 数量不够（自举没发生）、产物不能重算（对外产物成了第二份真相）、
  // demo 用了样例（S32 明令禁止）、资产读不动（数量靠坏文件凑）。
  assert.deepEqual(
    codes({ phase8: { ...PHASE8_GREEN, adrCount: 29, ok: false, violations: ["ADR 只有 29 条"] } }),
    [EVAL_CODES.BOOTSTRAP_DEGRADED],
  );
  assert.deepEqual(
    codes({ phase8: { ...PHASE8_GREEN, listingDeterministic: false, ok: false, violations: ["listing 两次生成不同"] } }),
    [EVAL_CODES.BOOTSTRAP_DEGRADED],
  );
  assert.deepEqual(
    codes({ phase8: { ...PHASE8_GREEN, demoFromOwnLibrary: false, ok: false, violations: ["demo 不是自己的库"] } }),
    [EVAL_CODES.BOOTSTRAP_DEGRADED],
  );
  assert.deepEqual(
    codes({ phase8: { ...PHASE8_GREEN, listingDraft: false, ok: false, violations: ["listing 自称已发布"] } }),
    [EVAL_CODES.BOOTSTRAP_DEGRADED],
  );
});

test("没有付费信号却开了团队能力 → E16（S30 的顺序被执行）", () => {
  assert.deepEqual(
    codes({
      phase8: {
        ...PHASE8_GREEN,
        team: {
          ...PHASE8_GREEN.team,
          violations: ["TEAM_CAPABILITY_WITHOUT_SIGNAL: 没有付费信号，但「权限」已经被打开了"],
        },
      },
    }),
    [EVAL_CODES.TEAM_UNGUARDED],
  );
});

test("团队版 deferred / partial 不是错误 —— 只有违规才报 E16", () => {
  // "还没做"与"做错了顺序"是两件事。把前者判红会让这条检查在 Phase 8 一开始
  // 就永远红着，而永远红着的检查等于没有检查。
  assert.deepEqual(
    codes({
      phase8: {
        ...PHASE8_GREEN,
        team: { ...PHASE8_GREEN.team, eligibility: "partial", paymentSignal: "PO-2026-001" },
      },
    }),
    [],
  );
});
