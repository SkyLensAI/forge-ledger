/**
 * eval 阈值的**判定** —— 纯函数，零 IO。
 *
 * 为什么判定住在这里、而 `scripts/gates/evals.mjs` 只是它的一个薄壳：
 * 与 `assets.mjs` 同一条理由——判定在能被复用的那一侧，宿主编排在外。
 * 但还有一条更直接的理由：**这段判定必须能在落地之前被测**。
 * 闸门本体是受保护路径（agent 写不了），如果判定逻辑写在那里，
 * 它就只能在人工落盘之后才第一次运行；而"闸门第一次运行"不该是演练。
 *
 * 这条分界和 `packages/core` 那条是同构的：判定 vs. 宿主。
 * 区别只在于，这里的判定是**闸门的**判定，不是产品的判定，所以它住在 `evals/`
 * 而不是 `packages/core`（R5 管的是产品逻辑，不是开发工具）。
 *
 * 它判七件事，其中三件不是"被测量者"的问题，而是**尺子/边界自己的问题**——
 * 而这三件恰恰是最容易被忽略的：分数难看的时候，所有人都会去调阈值。
 */

/** 本闸门的码。必须出现在 `docs/handbook/gates.md` 里（由 consistency.mjs 校验）。 */
export const EVAL_CODES = {
  /** 分数没够上阈值。 */
  BELOW_THRESHOLD: "E1_EVAL_BELOW_THRESHOLD",
  /** golden 集还没被人工确认——尺子目前等于"agent 给自己发合格证"。 */
  UNREVIEWED: "E2_EVAL_GOLDEN_UNREVIEWED",
  /** 候选断言的出处是编的/缺失的（信任边界被越过）。 */
  PROVENANCE: "E3_EVAL_CANDIDATE_PROVENANCE",
  /** 空实现也能及格：尺子瞎了。 */
  BLIND: "E4_EVAL_RULER_BLIND",
  /** 尺子自己坏了：用例的判据指不回原文、事件不合 schema、期望对不上输入。 */
  GOLDEN_INVALID: "E5_EVAL_GOLDEN_INVALID",
  /** 阈值文件还没被人工批准。 */
  THRESHOLD_UNRATIFIED: "E6_EVAL_THRESHOLD_UNRATIFIED",
  /** 信任边界被越过：敌意模型的产出穿过了 sanitize 或守卫。 */
  TRUST_BOUNDARY_OPEN: "E7_EVAL_TRUST_BOUNDARY_OPEN",
  /**
   * 合成的"新旧状态矛盾"没有 100% 进队列，或者进队列的证据对不上原文。
   * Phase 5 的退出条件的前半句（ADR-0027）。
   */
  CONFLICT_QUEUE_INCOMPLETE: "E8_EVAL_CONFLICT_QUEUE_INCOMPLETE",
  /**
   * 有一条冲突被**自动应用**了（或者判定模块有了 IO 的能力）。
   * Phase 5 的退出条件的后半句，也是 implement2.md 给 P5 写的那条 CI 强制项：
   * **无自动覆盖**。
   */
  CONFLICT_AUTO_APPLIED: "E9_EVAL_CONFLICT_AUTO_APPLIED",
  /**
   * 注入块撑破了预算。implement2.md 给 P6 写的那条 CI 强制项的前半句（S21）。
   *
   * 注意它是**两位数**的码——`scripts/gates/consistency.mjs` 里那条
   * "闸门码必须出现在 handbook 里"的检查用的正则只认一位数（`[A-G]\d_`），
   * 所以这两个码它会漏掉。这是**已知缺口**，写在 `docs/handbook/gates.md` 里，
   * 修法挂在 `handoff/`（改闸门脚本要走 ADR + 人工落盘）。
   */
  INJECTION_BUDGET: "E10_EVAL_INJECTION_BUDGET",
  /**
   * 预加载全库：注入里出现了分数为 0 的条目、注入条数接近整个库、
   * 或者对照查询（明明无关）也注入了东西。P6 强制项的后半句。
   */
  PRELOAD: "E11_EVAL_PRELOAD",
  /**
   * 审计不完整：链断了、三种破坏（删/改/换序）有没被抓住的、
   * 或者**不给见证人也能写资产**。implement2.md 给 P7 写的那条 CI 强制项
   * 就是这四个字：**审计完整性**。
   */
  AUDIT_GAP: "E12_EVAL_AUDIT_GAP",
  /**
   * 健康检查分不开"健康"和"烂掉"：干净语料上报了东西（噪音），
   * 或者某一组腐烂没被认出来（瞎了）。**两个方向都要判**——
   * 只会变红的检查与只会变绿的检查都不是检查。
   */
  HEALTH_BLIND: "E13_EVAL_HEALTH_BLIND",
  /**
   * 规模上去之后退化：同一份输入两次产出的字节不同，或者埋在 1000 条里
   * 那处腐烂被淹掉了。P7 的退出条件（"涨到 500–1000 条仍然可用"）的
   * **结构性替身**——它证明的是机器不崩、信号不淹，不是"库还好用"。
   */
  SCALE_DEGRADED: "E14_EVAL_SCALE_DEGRADED",
  /**
   * 自举 / 分发退化：ADR 跌破 implement2.md S29 的 30 条底线、资产读不动或审核不过、
   * demo / listing 不可重生成、或者 demo 不是从自己的库完整生成的。
   * P8 的交付物是**自举 + 上架 + demo**，三条都必须能被重算。
   */
  BOOTSTRAP_DEGRADED: "E15_EVAL_BOOTSTRAP_DEGRADED",
  /**
   * 团队版顺序被反过来：没有付费信号却已经打开权限 / 并发 / 敏感度切分中的任何一项。
   * implement2.md S30 的第一句话就是"只在出现付费信号后做"。
   * 代码证明不了有人付钱，但可以拒绝把"先做了"报告成"已就绪"。
   */
  TEAM_UNGUARDED: "E16_EVAL_TEAM_UNGUARDED",
} as const;

export type EvalCode = (typeof EVAL_CODES)[keyof typeof EVAL_CODES];

/** 判定只需要报告里的这几项，所以这里写窄到能穷举的形状，而不是 `any`。 */
export interface GateReport {
  extractor: string;
  scores: { precision: number; recall: number; f1: number; cases: number };
  threshold: { precision: number; recall: number };
  verdict: { ok: boolean; misses: string[] };
  review: { status: string; reviewed_by: string | null; cases_sha256?: string };
  /** 本次实际跑的用例指纹。与 `review.cases_sha256` 对不上 = 确认过期。 */
  goldenDigest: string;
  /** 本次实际用的阈值指纹。 */
  thresholdsDigest: string;
  goldenIssues: string[];
  candidateViolations: Array<{ code: string; path: string; message: string; fix: string }>;
  /** 信任边界探针的结果。判定只看它，不自己再跑一遍（判定要能从数据判）。 */
  trust: {
    ok: boolean;
    violationsAfterSanitize: number;
    admitted: number;
    inboxed: number;
    discarded: number;
    detail: string[];
  };
  /**
   * 冲突判定的探针结果（S18–S20）。
   *
   * 判定只看它，不自己再跑一遍——与 `trust` 同一条理由：
   * 判定要能**从数据**判，所以它读的是探针已经量好的东西。
   */
  retrieval: {
    ok: boolean;
    corpus: number;
    queries: number;
    injected: number;
    considered: number;
    irrelevant: number;
    maxBlockTokens: number;
    budget: number;
    violations: string[];
    preloaded: string[];
    blind: string[];
    goldenIssues: string[];
    detail: string[];
  };
  conflict: {
    ok: boolean;
    cases: number;
    expectedQueued: number;
    queued: number;
    evidenceChecked: number;
    missed: string[];
    spurious: string[];
    evidenceWrong: string[];
    assetsTouched: string[];
    ioViolations: string[];
    goldenIssues: string[];
    detail: string[];
    review: { status: string; reviewed_by: string | null; cases_sha256?: string };
    digest: string;
  };
  /**
   * 维护机器的探针结果（S25–S28）。判定只看它，不自己再跑一遍——
   * 与前三个探针同一条理由：判定要能**从数据**判。
   */
  maintenance: {
    ok: boolean;
    audit: {
      ok: boolean;
      entries: number;
      kinds: string[];
      cleanChainOk: boolean;
      caught: string[];
      missed: string[];
      unattributedSeen: boolean;
      refusesWithoutWitness: boolean;
      detail: string[];
    };
    health: {
      ok: boolean;
      cleanFindings: number;
      corpora: number;
      missed: string[];
      falsePositives: string[];
      readonlyOk: boolean;
      deterministic: boolean;
      detail: string[];
    };
    scale: {
      ok: boolean;
      assets: number;
      deterministic: boolean;
      plantedRotFound: boolean;
      detail: string[];
    };
  };
  /**
   * Phase 8 探针（S29–S32）。与前面几个探针同一个形状、同一条理由：
   * 判定只读探针已经量好的东西，不自己再跑一遍。
   */
  phase8: {
    ok: boolean;
    adrCount: number;
    adrTarget: number;
    assets: number;
    demoFiles: number;
    listingFiles: number;
    demoDeterministic: boolean;
    listingDeterministic: boolean;
    demoFromOwnLibrary: boolean;
    listingFromOwnLibrary: boolean;
    listingDraft: boolean;
    team: {
      eligibility: string;
      paymentSignal: string | null;
      missing: string[];
      violations: string[];
    };
    violations: string[];
    detail: string[];
  };
}

export interface GateThresholds {
  extraction: {
    precision: number;
    recall: number;
    ratified_by: string | null;
    ratified_at: string | null;
    thresholds_sha256?: string;
  };
}

export interface GateProblem {
  code: EvalCode;
  message: string;
}

/**
 * 判定：给"被测实现的报告 + 空实现的报告 + 阈值"，返回问题清单。
 *
 * @param {{ report: GateReport, nullReport: GateReport, thresholds: GateThresholds }} input
 * @returns {GateProblem[]}
 */
export function evaluateEvalGate(input: {
  report: GateReport;
  nullReport: GateReport;
  thresholds: GateThresholds;
}): GateProblem[] {
  const { report, nullReport, thresholds } = input;
  const problems: GateProblem[] = [];

  // ── 尺子自己坏了吗 ────────────────────────────────────────────────────
  for (const issue of report.goldenIssues) {
    problems.push({
      code: EVAL_CODES.GOLDEN_INVALID,
      message: `${issue}（分数不可采信——先修用例，再看分数）`,
    });
  }

  // ── 信任边界 ──────────────────────────────────────────────────────────
  for (const violation of report.candidateViolations) {
    problems.push({
      code: EVAL_CODES.PROVENANCE,
      message: `${violation.path}：${violation.message}（修法：${violation.fix}）`,
    });
  }

  // ── 分数 ──────────────────────────────────────────────────────────────
  if (!report.verdict.ok) {
    problems.push({
      code: EVAL_CODES.BELOW_THRESHOLD,
      message: `实现「${report.extractor}」没够上阈值：${report.verdict.misses.join("；")}`,
    });
  }

  // ── 人工确认（这是"先有尺子"的全部意义所在）──────────────────────────
  //
  // 两条：**有人确认过**，而且**确认的是这一份**。
  // 只查前者会留下一张能盖在任何后续改动上的橡皮图章——包括 agent 事后往
  // golden 集里塞一条恰好让当前实现变准的用例。所以确认记的是用例的指纹。
  //
  // **两把尺子共用这一段**：extraction 的 20 条用例，以及 Phase 5 的冲突合成集。
  // 各写一段的结局是两者的"确认"含义悄悄分叉——而那正是这条检查要防的事。
  for (const [name, golden] of [
    ["extraction", { review: report.review, digest: report.goldenDigest, file: "evals/golden/extraction/cases.json" }],
    ["conflict", { review: report.conflict.review, digest: report.conflict.digest, file: "evals/golden/conflict/cases.json" }],
  ] as const) {
    if (golden.review.status !== "confirmed") {
      problems.push({
        code: EVAL_CODES.UNREVIEWED,
        message:
          `${name} 的 golden 集状态是「${golden.review.status}」，还没被人工确认。` +
          `一条没人确认过的黄金集，就是让被测者给自己出题、自己判卷。` +
          `确认方法：逐条读 ${golden.file} 的 why，核对它指出的原文里确实记着这件事，` +
          `然后把 review 块填上（两把尺子同一套办法，见 evals/README.md）。`,
      });
    } else if (golden.review.cases_sha256 !== golden.digest) {
      problems.push({
        code: EVAL_CODES.UNREVIEWED,
        message:
          `${name} 的 golden 集在确认之后被改过（指纹 ${(golden.review.cases_sha256 ?? "(缺)").slice(0, 12)} → ` +
          `${golden.digest.slice(0, 12)}）。**确认绑的是内容，不是文件名**：` +
          `加一条、删一条、改一个期望值，都要重新确认。` +
          `（把 review 块的 status 退回 proposed，或核对之后写上新指纹。）`,
      });
    }
  }

  const ratified = thresholds.extraction.ratified_by;
  if (ratified === null || ratified.trim().length === 0) {
    problems.push({
      code: EVAL_CODES.THRESHOLD_UNRATIFIED,
      message:
        `evals/thresholds.json 里的阈值还没被人工批准。` +
        `阈值决定了"什么算及格"，而那是人的判断，不是 agent 的自选参数` +
        `（implement2.md 的人机分工表：P3 的"人必须做"就是阈值与 golden 集）。`,
    });
  } else if (thresholds.extraction.thresholds_sha256 !== report.thresholdsDigest) {
    problems.push({
      code: EVAL_CODES.THRESHOLD_UNRATIFIED,
      message:
        `阈值在批准之后被改过（指纹 ${(thresholds.extraction.thresholds_sha256 ?? "(缺)").slice(0, 12)} → ` +
        `${report.thresholdsDigest.slice(0, 12)}）。改阈值等于改"什么算及格"，` +
        `所以改完要重新批准——否则调低阈值就成了最省事的过关方式。`,
    });
  }

  // ── 尺子还睁着眼吗（Phase 3 的退出条件本身）───────────────────────────
  //
  // 为什么用"召回率 >= 阈值"而不是"verdict.ok === false"：
  // 空实现的精确率天然是 0（没有产出就没有误报可言），所以只看 `verdict.ok`
  // 已经够了。但把召回率单独写出来，是为了让这条检查即使在某天阈值被调成
  // 只卡精确率时**依然有效**——那时空的实现会以 1.000 的"精确率"蒙混过关。
  if (nullReport.verdict.ok || nullReport.scores.recall >= report.threshold.recall) {
    problems.push({
      code: EVAL_CODES.BLIND,
      message:
        `把抽取器换成"永远返回空"的假实现之后，它**依然及格**` +
        `（召回率 ${nullReport.scores.recall}，阈值 ${report.threshold.recall}）。` +
        `尺子已经分不开活的和死的了——先修尺子，再接模型（Phase 3 的退出条件）。`,
    });
  }

  // ── 信任边界还连着吗（Phase 4 的退出条件本身）─────────────────────────
  //
  // `E4` 证明尺子分得开"活的和死的"，但分不开"对的"和"**听起来对、出处是编的**"。
  // 后者才是本产品最贵的失败模式：它分数好看，而每一条都不可复核。
  // 所以这一条不看分数——它拿一台敌意模型走完整的真实路径，然后要求：
  // 一条编造出处的候选都不许活下来，一条模型产出都不许被判成可直接入库。
  if (!report.trust.ok) {
    problems.push({
      code: EVAL_CODES.TRUST_BOUNDARY_OPEN,
      message:
        `信任边界被越过了（探针：${report.trust.violationsAfterSanitize} 条违规留存、` +
        `${report.trust.admitted} 条被判可直接入库、${report.trust.inboxed} 条进候选区）：` +
        `${report.trust.detail.join("；")}`,
    });
  }

  // ── 冲突：队列还在工作吗（Phase 5 的退出条件 · 前半句）───────────────────
  //
  // 这一条读的是**合成的"新旧状态矛盾"**：该进队列的必须 100% 进队列，
  // 而且每条的证据要解析得到原文、原文里确实写着它声称的那句话。
  // 只查"进没进"会漏掉两侧证据写反了的那种——它看起来完全正常，
  // 但它把整个队列的意思颠倒过来了。
  if (report.conflict.goldenIssues.length > 0) {
    for (const issue of report.conflict.goldenIssues) {
      problems.push({
        code: EVAL_CODES.GOLDEN_INVALID,
        message: `${issue}（冲突合成集自己坏了——先修用例，再看队列）`,
      });
    }
  }

  if (!report.conflict.ok) {
    const detail = [
      ...report.conflict.missed,
      ...report.conflict.spurious,
      ...report.conflict.evidenceWrong,
      ...report.conflict.detail,
    ];
    problems.push({
      code: EVAL_CODES.CONFLICT_QUEUE_INCOMPLETE,
      message:
        `合成矛盾集没有全部正确进队列（${String(report.conflict.cases)} 条用例、` +
        `期望 ${String(report.conflict.expectedQueued)} 条进队列、实际 ${String(report.conflict.queued)} 条、` +
        `核对过证据 ${String(report.conflict.evidenceChecked)} 条）：${detail.join("；") || "见探针明细"}`,
    });
  }

  // ── 冲突：队列有没有越权（Phase 5 的退出条件 · 后半句；CI 强制项）────────
  //
  // implement2.md 给 P5 写的那条强制项就是四个字：**无自动覆盖**。
  // 两个判据一起看：判定模块**有没有 IO 的能力**（有能力才谈得上自动应用），
  // 以及走完"判定 → 落队列"之后**资产侧变没变**。
  // 只看后者不够：一个"这次没写盘"的实现照样可以在下一次写盘。
  if (report.conflict.assetsTouched.length > 0 || report.conflict.ioViolations.length > 0) {
    problems.push({
      code: EVAL_CODES.CONFLICT_AUTO_APPLIED,
      message:
        `判定的路径上出现了"能自动应用"的痕迹（改动资产 ${String(report.conflict.assetsTouched.length)} 处、` +
        `判定模块里的 IO/时钟 ${String(report.conflict.ioViolations.length)} 处）：` +
        `${[...report.conflict.assetsTouched, ...report.conflict.ioViolations].join("；")}。` +
        `冲突必须等人 resolve——队列是唯一能改写已有状态的通路（ADR-0027/0028）。`,
    });
  }

  // ── 取用：注入预算还守不守得住（Phase 6 的 CI 强制项）─────────────────────
  //
  // 两条判据分开，是因为它们防的是两件不同的事、修法也不同：
  // 预算被撑破 = 某次改动让注入块长大了（去修注入）；
  // 预加载 = 相关性判断退化了（去修检索），而它**不会**让预算检查变红——
  // 一个把全库倒出来的实现只要"预算够大"就全程绿灯。
  for (const issue of report.retrieval.goldenIssues) {
    problems.push({
      code: EVAL_CODES.GOLDEN_INVALID,
      message: `${issue}（取用探针读不出语料——这次读数不可采信）`,
    });
  }

  if (report.retrieval.violations.length > 0 || report.retrieval.blind.length > 0) {
    problems.push({
      code: EVAL_CODES.INJECTION_BUDGET,
      message:
        `注入预算这条边界被越过了：${[...report.retrieval.violations, ...report.retrieval.blind].join("；")}。` +
        `（语料 ${String(report.retrieval.corpus)} 条 · 查询 ${String(report.retrieval.queries)} 条 · ` +
        `单块最大 ${String(report.retrieval.maxBlockTokens)} token / 预算 ${String(report.retrieval.budget)}）` +
        `P6 的 CI 强制项就是这四个字：**注入预算**。要更多内容就给更大的预算，` +
        `而不是让注入块自己长大——它长大之后使用方的窗口会静默地少掉一截。`,
    });
  }

  if (report.retrieval.preloaded.length > 0) {
    problems.push({
      code: EVAL_CODES.PRELOAD,
      message:
        `检索退化成了预加载：${report.retrieval.preloaded.join("；")}。` +
        `库共 ${String(report.retrieval.corpus)} 条，本轮注入了 ${String(report.retrieval.injected)} 条，` +
        `其中无关的只判出 ${String(report.retrieval.irrelevant)} 条。` +
        `预加载会 context rot，而且它**不会**让预算检查变红——所以它必须单独判（ADR-0029）。`,
    });
  }

  // ── 维护：审计完整性（Phase 7 的 CI 强制项）────────────────────────────
  //
  // implement2.md 给 P7 写的那条强制项就是这四个字。它有两个方向，缺一不可：
  // **链必须是真的**（删/改/换序三种破坏都要被抓住），
  // **写门必须是真的**（不给见证人时，代码要拒绝）。
  // 只查前者的实现留了一个后门：日志漂亮，但下一次写入可以不打招呼。
  const auditProbe = report.maintenance.audit;
  if (!auditProbe.ok || !auditProbe.cleanChainOk || !auditProbe.refusesWithoutWitness) {
    problems.push({
      code: EVAL_CODES.AUDIT_GAP,
      message:
        `审计不完整：${auditProbe.missed.join("；") || "见探针明细"}。` +
        `（真的写入路径产出 ${String(auditProbe.entries)} 条 · 干净时链${auditProbe.cleanChainOk ? "" : "**不"}完整** · ` +
        `三种破坏抓住 ${String(auditProbe.caught.length)}/3 · 手写文件${auditProbe.unattributedSeen ? "被看见" : "**没被看见**"}）` +
        `修法是修**写路径**（\`writeAuthored\` 的见证人不许变成可选），不是放宽探针。`,
    });
  }

  // ── 维护：健康检查还分得开好坏吗 ──────────────────────────────────────
  //
  // 两个方向一起判，因为它们的失败方式相反、修法也不同：
  // 干净语料上报东西 = 噪音（人会把报告关掉）；某组腐烂没报 = 瞎了（人以为库是好的）。
  const healthProbe = report.maintenance.health;
  if (!healthProbe.ok || !healthProbe.readonlyOk || !healthProbe.deterministic) {
    problems.push({
      code: EVAL_CODES.HEALTH_BLIND,
      message:
        `健康检查分不开「健康」和「烂掉」：` +
        `${[...healthProbe.missed, ...healthProbe.falsePositives].join("；") || "见探针明细"}。` +
        `（${String(healthProbe.corpora)} 组语料 · 干净那组报了 ${String(healthProbe.cleanFindings)} 条 · ` +
        `只读 ${healthProbe.readonlyOk ? "是" : "**否**"} · 可重印 ${healthProbe.deterministic ? "是" : "**否**"}）` +
        `一个见到什么都报的实现能让所有"该报的报了"全绿，所以**两组都要**：干净时零发现，烂的时候只报那一种。`,
    });
  }

  // ── 维护：规模上去之后退化了没有（P7 退出条件的结构性替身）───────────
  const scaleProbe = report.maintenance.scale;
  if (!scaleProbe.ok) {
    problems.push({
      code: EVAL_CODES.SCALE_DEGRADED,
      message:
        `库涨到 ${String(scaleProbe.assets)} 条之后退化了：` +
        `${scaleProbe.deterministic ? "" : "同一份输入两次产出的字节不同（R6 在规模上不成立）；"}` +
        `${scaleProbe.plantedRotFound ? "" : "埋在语料里那处「替换写了一半」没有被找到（信号被规模淹掉）；"}` +
        `${scaleProbe.detail.join("；")}`,
    });
  }

  // ── Phase 8：自举 / 上架 / demo 还成不成立 ─────────────────────────────
  //
  // 这一条把 S29–S32 的交付物放在每次 CI 里问一遍：
  // ADR 跌破 30 条、资产读不动、产物不可重生成、demo 不是自己的库——
  // 任何一条成立，都说明"自举"只是文档里的一句话。
  if (!report.phase8.ok) {
    problems.push({
      code: EVAL_CODES.BOOTSTRAP_DEGRADED,
      message:
        `自举 / 分发的边界被越过了：${report.phase8.violations.join("；") || "见探针明细"}。` +
        `（ADR ${String(report.phase8.adrCount)}/${String(report.phase8.adrTarget)} · ` +
        `资产 ${String(report.phase8.assets)} 条 · demo ${String(report.phase8.demoFiles)} 个文件 · ` +
        `listing ${String(report.phase8.listingFiles)} 个文件）` +
        `修法是补真实 ADR、修资产、或重新生成产物，**不是**关掉探针。`,
    });
  }

  // ── Phase 8：团队版有没有在没信号的时候先长出来 ────────────────────────
  //
  // `deferred` / `partial` 不是错误：前者是 S30 的前提还没发生，后者是信号有了、
  // 能力还没做齐。**只有违规**——没有信号却开了能力——才让这条检查变红。
  const teamViolations = report.phase8.team.violations;
  if (teamViolations.length > 0) {
    problems.push({
      code: EVAL_CODES.TEAM_UNGUARDED,
      message:
        `团队版顺序被反过来了：${teamViolations.join("；")}。` +
        `implement2.md S30：团队版只在出现付费信号后做；没有信号时，权限 / 并发 / ` +
        `敏感度切分必须全部关着。代码证明不了有人付钱，但能拒绝把"先做了"报告成"已就绪"。`,
    });
  }

  return problems;
}

/**
 * 给人看的输出。**排序过**：同一份报告跑两次要打出同样的行（R6 也管报告）。
 *
 * @param {GateProblem[]} problems
 * @returns {string[]}
 */
export function formatGateProblems(problems: GateProblem[]): string[] {
  return [...problems]
    .sort((a, b) => (a.code === b.code ? (a.message < b.message ? -1 : 1) : a.code < b.code ? -1 : 1))
    .map((problem) => `  [${problem.code}] ${problem.message}`);
}
