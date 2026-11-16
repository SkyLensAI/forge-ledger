/**
 * 冲突判定的探针 —— **每次 CI 都问一遍"队列还在工作、而它没有越权吗"**（S19/S20 的 `E8`/`E9`）。
 *
 * 它为什么必须每次跑（ADR-0024 的同一条理由）：
 * 冲突判定的判据看上去很"硬"（同题面 + 内容不同），但它的三条性质可以被**悄悄**弄坏，
 * 而弄坏之后分数、lint、类型检查全都照样绿：
 *
 * 1. **该进队列的没进**（判据被改窄了，或者某个 early return 吃掉了整批）；
 * 2. **证据对不上**（引用的原文里根本没写那句话——一条核对不了的记录比没有更糟）；
 * 3. **某处把冲突直接应用了**（"低风险的那一档就自动刷新吧"——ADR-0027 的选项 2）。
 *
 * 三条各自有不同的后果，所以三条各自有检查。第 3 条的判定分两半：
 * 判定模块**有没有 IO**（有 IO 才谈得上自动应用），以及走完整条
 * "判定 → 落队列"的路径之后**资产侧变没变**。
 *
 * 依赖是**可注入的**（`deps`），所以探针自己可以被测：传一个"模型能一票否决"的判定、
 * 传一个"顺手把新的写进资产"的落盘实现，探针必须报红。只会变绿的检查不是检查（R8）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFLICT_BASIS,
  cleanSubject,
  conflictKeyOf,
  detectConflicts,
  judgeConflicts,
  normalizeText,
  normalizeValue,
  parseSpan,
  formatSpan,
  type AssetRef,
  type CandidateAssertion,
  type ConflictCandidate,
  type ConflictJudge,
  type ConflictJudgement,
} from "../../packages/core/src/index.ts";
import {
  CONFLICT_STATUS,
  conflictIdOf,
  recordOf,
  writeConflicts,
  type ConflictIncumbentRecord,
  type ConflictLayer,
  type ConflictRecord,
} from "../../packages/store/src/index.ts";
import { buildSpanIndex } from "../../packages/store/src/index.ts";
import { digestOf, type ReviewRecord } from "./review.ts";

/** golden 集里一条用例的原始形状。 */
interface RawConflictCase {
  id: string;
  about: string;
  judge?: string;
  incumbent: {
    asset_id: string;
    path: string;
    status: string;
    body: string;
    sources: string[];
    subject: string | null;
  };
  extra_incumbents?: RawConflictCase["incumbent"][];
  incoming: { title: string; subject: string | null; body: string; sources: string[] };
  expect: { queued: number; refreshed?: number; dropped: number; basis?: string; notes?: number };
}

interface ConflictGoldenSet {
  schema_version: number;
  kind: string;
  about: string;
  review: ReviewRecord;
  cases: RawConflictCase[];
}

export interface ConflictProbeResult {
  ok: boolean;
  cases: number;
  /** 用例期望进队列的总条数。 */
  expectedQueued: number;
  /** 实际进队列的总条数。 */
  queued: number;
  /** 逐条核对过证据（解析得到 + 原文里确实写着那句话）的候选数。 */
  evidenceChecked: number;
  /** 该进队列却没进的。 */
  missed: string[];
  /** 不该进队列却进了的。 */
  spurious: string[];
  /** 证据对不上的：解析不到、或者原文里没写它声称的那句话。 */
  evidenceWrong: string[];
  /** 走完整条"判定 → 落队列"之后，资产侧仍然变了的东西（必须为空）。 */
  assetsTouched: string[];
  /** 判定模块里出现的 IO / 非确定性调用（必须为空）。 */
  ioViolations: string[];
  /** 尺子自己的问题（用例指不回原文…）。非空 = 结果不可采信。 */
  goldenIssues: string[];
  /** 探针那些"判定本身"的输出（进闸门报告）。 */
  detail: string[];
  review: ReviewRecord;
  digest: string;
}

/**
 * 探针给 `cf-007` 注入的模型：**什么都觉得像**。
 *
 * 为什么要一台恒说"是"的模型：那正是最坏的那一种。它说"是"的代价
 * （两条事实被合成一条）在产品里是不可逆的，而这条探针要钉住的正是
 * "它说了不算"——提议进队列，且**规则已经查到的那些一条都不许少**。
 */
export const eagerProbeJudge: ConflictJudge = {
  id: "eager-probe",
  propose: () => ["探针恒这么答：它们说的是同一件事"],
};

/** 可注入的依赖。默认是真实实现；测试传坏实现，验证探针会红。 */
export interface ConflictProbeDeps {
  judge?: typeof judgeConflicts;
  write?: typeof writeConflicts;
  readSource?: (relativePath: string) => string | null;
}

/**
 * 判定模块里**不许出现**的东西。
 *
 * 前三条是 IO：判定一旦能碰文件系统，它就具备了"顺手把结论写下去"的能力，
 * 而那正是 ADR-0027 判据 1 要拦的事（`packages/core` 的纪律是零 IO，R5）。
 * 后两条是时钟与随机：它们会立刻破坏"同一份输入产出同样的结果"（R6）。
 *
 * @type {ReadonlyArray<{pattern: RegExp; why: string}>}
 */
const FORBIDDEN_IN_JUDGEMENT = [
  { pattern: /from\s+"node:fs/, why: "判定模块引入了文件系统：它一旦能写，就有可能顺手把冲突应用掉" },
  { pattern: /from\s+"node:child_process/, why: "判定模块引入了子进程" },
  { pattern: /from\s+"@forge\/store/, why: "判定模块直接依赖存储层：判定与落盘必须由调用方分开" },
  { pattern: /from\s+"@forge\/ingest/, why: "判定模块依赖了采集层：那是另一条流水线的事" },
  { pattern: /\bDate\.now\b|\bnew Date\(\)/, why: "判定模块读了时钟：同一份输入将不再产出同样的结果（R6）" },
  { pattern: /\bMath\.random\b/, why: "判定模块用了随机数：同一份输入将不再产出同样的结果（R6）" },
];

/**
 * 跑一次探针。
 *
 * @param {string} repoRoot 仓库根：golden 集与要扫的源码都相对它解析
 * @param {ConflictProbeDeps} [deps]
 * @returns {ConflictProbeResult}
 */
export function runConflictProbe(repoRoot: string, deps: ConflictProbeDeps = {}): ConflictProbeResult {
  const judgeFn = deps.judge ?? judgeConflicts;
  const writeFn = deps.write ?? writeConflicts;
  const readSource = deps.readSource ?? ((relative: string) => readFileSync(join(repoRoot, relative), "utf8"));

  const set = loadConflictSet(repoRoot);
  const spanIndex = buildSpanIndex({ sources: null, workspaces: [repoRoot] });

  const missed: string[] = [];
  const spurious: string[] = [];
  const evidenceWrong: string[] = [];
  const goldenIssues: string[] = [];
  const detail: string[] = [];
  const assetsTouched: string[] = [];

  let expectedQueued = 0;
  let queued = 0;
  let evidenceChecked = 0;

  const seenIds = new Set<string>();

  for (const item of set.cases) {
    if (seenIds.has(item.id)) goldenIssues.push(`用例 ID 重复：${item.id}`);
    seenIds.add(item.id);

    // ── 先审尺子自己：两侧的证据必须指得回原文，而且原文里确实写着那句话 ──
    const incumbents = [item.incumbent, ...(item.extra_incumbents ?? [])];
    const sides: Array<{ label: string; value: string; sources: string[] }> = [
      { label: `${item.id}·incoming`, value: item.incoming.body, sources: item.incoming.sources },
      ...incumbents.map((incumbent, index) => ({
        label: `${item.id}·incumbent${index === 0 ? "" : String(index)}`,
        value: incumbent.body,
        sources: incumbent.sources,
      })),
    ];
    for (const side of sides) {
      // 一侧**故意**没有出处是某些用例的题材本身（cf-006：新证据没有出处 → 必须被丢）。
      // 那种情况不算尺子坏了，但它必须与"期望丢一条"配对——一个没有出处、
      // 却期望进队列的用例是自相矛盾的，那才是尺子坏了。
      if (side.sources.length === 0) {
        if (item.expect.dropped === 0) {
          goldenIssues.push(`${side.label}：这一侧没有出处，而用例期望它进队列——两件事对不上`);
        }
        continue;
      }
      goldenIssues.push(...evidenceProblems(side.label, side.value, side.sources, spanIndex));
    }

    // ── 跑判定 ────────────────────────────────────────────────────────────
    const candidates: CandidateAssertion[] = [candidateOf(item)];
    const assets: AssetRef[] = incumbents.map((incumbent) => assetRefOf(incumbent));
    const judgement = judgeFn({
      candidates,
      assets,
      ...(item.judge === undefined ? {} : { judge: judgeFor(item.judge) }),
    });

    const actual = judgement.conflicts.length;
    expectedQueued += item.expect.queued;
    queued += actual;

    if (actual < item.expect.queued) {
      missed.push(`${item.id}：期望 ${String(item.expect.queued)} 条进队列，实际 ${String(actual)} 条`);
    } else if (actual > item.expect.queued) {
      spurious.push(`${item.id}：期望 ${String(item.expect.queued)} 条进队列，实际多了 ${String(actual - item.expect.queued)} 条`);
    }
    if ((judgement.dropped.length > 0) !== (item.expect.dropped > 0)) {
      const direction = item.expect.dropped > 0 ? "该丢的没丢" : "不该丢的丢了";
      detail.push(`${item.id}：丢弃计数与期望不一致（${direction}，实际 ${String(judgement.dropped.length)} 条）`);
      missed.push(`${item.id}：${direction}`);
    }
    if (item.expect.refreshed !== undefined && judgement.refreshes.length !== item.expect.refreshed) {
      missed.push(`${item.id}：期望 ${String(item.expect.refreshed)} 条"再确认"，实际 ${String(judgement.refreshes.length)} 条`);
    }
    if (item.expect.notes !== undefined && judgement.notes.length !== item.expect.notes) {
      missed.push(`${item.id}：期望 ${String(item.expect.notes)} 条旁注，实际 ${String(judgement.notes.length)} 条`);
    }
    if (item.expect.basis !== undefined) {
      const bases = new Set(judgement.conflicts.map((conflict) => conflict.basis));
      if (bases.size > 0 && ![...bases].every((basis) => basis === item.expect.basis)) {
        missed.push(`${item.id}：期望 basis=${item.expect.basis}，实际 ${[...bases].join("、")}`);
      }
    }

    // ── 每一条进队列的候选，它的证据都要能被核对 ─────────────────────────
    for (const conflict of judgement.conflicts) {
      evidenceChecked += 1;
      // 两侧各查一遍：**"这一侧的证据指向它声称的那句话"**。
      // 两侧都查，才能发现"证据写反了"这一类——它看起来完全正常。
      const problems = [
        ...evidenceProblems(`${item.id}·新证据`, conflict.incoming.value, conflict.incoming.sources, spanIndex),
        ...evidenceProblems(`${item.id}·现状`, conflict.incumbent.value, conflict.incumbent.sources, spanIndex),
      ];
      if (conflict.evidence.length === 0) problems.push(`${item.id}：这条冲突一条证据都没有`);
      for (const problem of problems) evidenceWrong.push(problem);
    }

    // ── 落队列（内存里），并确认**资产侧一个字节都没变** ──────────────────
    const snapshot = JSON.stringify(assets);
    const layer = memoryLayer();
    const incumbentRecords = new Map<string, { incumbent: ConflictIncumbentRecord; subject: string; candidateId: string }>();
    for (const conflict of judgement.conflicts) {
      const asset = assets.find((ref) => ref.id === conflict.incumbent.assetId);
      if (asset === undefined) continue;
      incumbentRecords.set(conflict.key, {
        incumbent: {
          asset_id: asset.id,
          path: asset.path,
          status: asset.status,
          label: asset.path,
          value: conflict.incumbent.value,
          sources: conflict.incumbent.sources,
        },
        subject: conflict.incoming.candidate.subject ?? "",
        candidateId: "cand_probe",
      });
    }
    writeFn(layer, judgement, incumbentRecords);

    if (JSON.stringify(assets) !== snapshot) {
      assetsTouched.push(`${item.id}：走完"判定 → 落队列"之后资产侧被改动了`);
    }
    if (layer.scan().records.length !== judgement.conflicts.length) {
      assetsTouched.push(
        `${item.id}：队列记录数（${String(layer.scan().records.length)}）与冲突候选数（${String(judgement.conflicts.length)}）对不上`,
      );
    }
    for (const record of layer.scan().records) {
      // 队列记录里**不许**有"已经被应用"的痕迹（ADR-0027 判据 1）：
      // 只有人的 resolve 能让 `resolution` 非空，而探针从不 resolve。
      if (record.resolution !== null) {
        assetsTouched.push(`${item.id}：队列记录 ${record.conflict_id} 在没有人 resolve 的情况下带了决议`);
      }
    }
  }

  const ioViolations = scanForIo(readSource);

  const result: ConflictProbeResult = {
    ok:
      missed.length === 0 &&
      spurious.length === 0 &&
      evidenceWrong.length === 0 &&
      goldenIssues.length === 0 &&
      assetsTouched.length === 0 &&
      ioViolations.length === 0 &&
      expectedQueued > 0 &&
      evidenceChecked > 0,
    cases: set.cases.length,
    expectedQueued,
    queued,
    evidenceChecked,
    missed: [...missed].sort(),
    spurious: [...spurious].sort(),
    evidenceWrong: [...evidenceWrong].sort(),
    assetsTouched: [...assetsTouched].sort(),
    ioViolations,
    goldenIssues: [...goldenIssues].sort(),
    detail: [...detail].sort(),
    review: set.review,
    digest: digestOf(set.cases),
  };

  if (result.evidenceChecked === 0) {
    result.detail.push(
      "一条证据都没核对过：一个『什么都不报』的实现也能让上面几条全绿，所以这次检查不成立。",
    );
  }
  return result;
}

/**
 * 一侧的证据"对不对" —— **这是"证据正确"的定义**，写成函数是因为它在两个地方要用：
 * 审 golden 集自己，以及审每一条真正进队列的冲突候选。
 *
 * 两条判据，缺一不可：
 *
 * 1. **每一处都要解析得到**（宿主能在那份文件里找到它）。解析不到的出处
 *    就是一条凭空发明的出处——ADR-0009 的那条理由。
 * 2. **这一侧至少要有一处出处指向它声称的那句话**。只查第 1 条会漏掉
 *    "引错了位置"与"两侧写反了"：那两种错误看起来完全正常，
 *    而它们把整个队列的意思颠倒过来了。
 *    判据落在**锚点内容**上（`#t:` 的片段、`#L:` 的行区间），不是落在
 *    "索引回显的那一行"上——回显只是取首词所在行，它挑不出你要的那一句。
 *
 * @param {string} label 人读的定位（`cf-001·incoming`）
 * @param {string} value 这一侧声称的那句话
 * @param {string[]} sources 它的出处列表
 * @param {ReturnType<typeof buildSpanIndex>} spanIndex 出处索引
 * @returns {string[]} 空数组 = 这一侧的证据站得住
 */
export function evidenceProblems(
  label: string,
  value: string,
  sources: string[],
  spanIndex: ReturnType<typeof buildSpanIndex>,
): string[] {
  const problems: string[] = [];
  const wanted = normalizeValue(value);
  let carries = false;

  for (const raw of sources) {
    const parsed = parseSpan(raw);
    if (!parsed.ok) {
      problems.push(`${label}：证据「${raw}」不是合法 span——${parsed.reason}`);
      continue;
    }
    const fact = spanIndex.lookup(formatSpan(parsed.span));
    if (fact.kind !== "resolved") {
      problems.push(
        `${label}：证据 ${formatSpan(parsed.span)} 解析不到（${fact.kind}）——` +
          `一条指不回原文的证据，就是一条凭空发明的证据。`,
      );
      continue;
    }

    const anchor = parsed.span.anchor;
    if (anchor === null) continue;
    if (anchor.kind === "t" && normalizeText(anchor.payload).includes(wanted)) carries = true;
    if (anchor.kind === "L" && normalizeText(fact.excerpt).includes(wanted)) carries = true;
  }

  if (!carries) {
    problems.push(
      `${label}：这一侧没有一处出处**指向它声称的那句话**（声称：${wanted}）。` +
        `光"解析得到"不够——引错位置与编造出处，在报告里长得一模一样。`,
    );
  }
  return problems;
}

/**
 * 判定模块里不许有 IO / 时钟 / 随机。
 *
 * 为什么扫**源码文本**而不是"跑一遍看它写没写盘"：一个"没写盘"的实现在测试里
 * 也永远不写盘——那样验的是这次调用，不是这条设计。扫源码验的是**能力**：
 * 判定模块一旦有能力碰 IO，"自动应用"就只差一次代码评审。
 *
 * @param {(relativePath: string) => string | null} readSource
 * @returns {string[]}
 */
export function scanForIo(readSource: (relativePath: string) => string | null): string[] {
  const files = ["packages/core/src/conflict.ts", "packages/core/src/link.ts"];
  const violations: string[] = [];
  for (const file of files) {
    const text = readSource(file);
    if (text === null) {
      violations.push(`${file} 读不到——无法校验它有没有 IO，这是「无法校验」不是「通过」`);
      continue;
    }
    for (const entry of FORBIDDEN_IN_JUDGEMENT) {
      if (entry.pattern.test(text)) violations.push(`${file}：${entry.why}`);
    }
  }
  return violations.sort();
}

/**
 * @param {string} repoRoot
 * @returns {ConflictGoldenSet}
 */
export function loadConflictSet(repoRoot: string): ConflictGoldenSet {
  const path = join(repoRoot, "evals", "golden", "conflict", "cases.json");
  return JSON.parse(readFileSync(path, "utf8")) as ConflictGoldenSet;
}

/**
 * 把一条用例铸成候选断言。
 *
 * 与真实路径一样经过 `cleanSubject`：题面的清洗在 sanitize 里做，
 * 而探针不该绕过那一步——否则它测的是"如果题面已经是干净的会怎样"。
 *
 * @param {RawConflictCase} item
 * @returns {CandidateAssertion}
 */
function candidateOf(item: RawConflictCase): CandidateAssertion {
  return {
    type: "state",
    title: item.incoming.title,
    subject: cleanSubject(item.incoming.subject),
    body: item.incoming.body,
    sources: [...item.incoming.sources],
    confidence: 0.3,
    // 探针模拟的是**模型抽出来的**候选：它必须走"提议"那一档，
    // 而不是被当成一条已经落盘的资产。
    origin: "model",
  };
}

/**
 * @param {RawConflictCase["incumbent"]} incumbent
 * @returns {AssetRef}
 */
function assetRefOf(incumbent: RawConflictCase["incumbent"]): AssetRef {
  return {
    id: incumbent.asset_id,
    path: incumbent.path,
    type: "state",
    subject: cleanSubject(incumbent.subject),
    sources: [...incumbent.sources],
    status: incumbent.status,
    body: incumbent.body,
  };
}

/**
 * @param {string} id
 * @returns {ConflictJudge}
 */
function judgeFor(id: string): ConflictJudge {
  if (id === eagerProbeJudge.id) return eagerProbeJudge;
  throw new Error(`golden 集里写了不存在的判定接缝「${id}」：可用的只有 ${eagerProbeJudge.id}`);
}

/**
 * 一个**内存里的**冲突队列：探针要验"落队列之后资产侧变没变"，
 * 而它不该碰工作区（`evals/` 是开发工具目录，不是用户的库）。
 *
 * 它实现的是真的 `ConflictLayer` 接口，所以 `writeConflicts` 与 `recordOf`
 * 都是**真实的那两份代码**——探针测的不是一段仿写。
 *
 * @returns {ConflictLayer}
 */
function memoryLayer(): ConflictLayer {
  const files = new Map<string, ConflictRecord>();
  const layer: ConflictLayer = {
    scan: () => ({ records: [...files.values()].sort((a, b) => (a.conflict_id < b.conflict_id ? -1 : 1)), invalid: [] }),
    read: (conflictId) => files.get(conflictId) ?? null,
    put: (record) => {
      const created = !files.has(record.conflict_id);
      files.set(record.conflict_id, record);
      return { path: `${record.conflict_id}.json`, created };
    },
    markResolved: (conflictId) => files.has(conflictId),
    remove: (conflictId) => files.delete(conflictId),
  };
  return layer;
}
