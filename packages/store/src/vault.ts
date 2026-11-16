/**
 * vault 的三个层与它们之间的**唯一一条流水线**。
 *
 * 流水线的形状是确定的，这不是实现细节而是纪律（implement1.md §3.2）：
 *
 *     sources（只读） ──连接器──▶ 事件 IR ──▶ assets（编译层）
 *                                       └──▶ index（可重建）
 *
 *                             事件 IR ──模型──▶ 候选断言 ──守卫──▶ _inbox（候选区）
 *
 * **没有 orchestrator agent 在这里做决定**。哪一步跑、按什么顺序、失败了怎么办，
 * 全部写死在这段代码里。理由很直接：本产品的卖点是可复现、可审计、有出处，
 * 而"让一个大 agent 自己决定怎么干"与这三条直接冲突（反模式 5）。
 *
 * 第二段（抽取）是 Phase 4 加的那条。它有两个**结构性**的性质：
 *
 * - **模型在中间，不在两端。** 左端是确定性的连接器，右端是确定性的守卫与写盘。
 *   模型只是中间那个可替换的函数，所以"换模型"和"换一个 cassette 文件"是同一件事。
 * - **写盘分两步，中间有一次判定。** `extract()` 全部算完再动盘，
 *   所以一次抽取要么完整落进候选区，要么什么都不落——不会留下半套。
 *
 * 这一段是全项目唯一允许有副作用的编译路径，所以它必须同时是**幂等**的：
 * 同一份 sources + assets 跑两次，产出的字节完全一样（Phase 2 的退出条件）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_GUARD_POLICY,
  AUDIT_KINDS,
  detectConflicts,
  deriveEvents,
  emitIndex,
  entitiesOf,
  extractFromModel,
  guardCandidates,
  buildCapturePayload,
  captureKeyOf,
  freshItems,
  judgeConflicts,
  linkCandidates,
  normalizeSubjectKey,
  renderHealthReport,
  renderInjection,
  renderWeeklyReport,
  retrievalViolations,
  retrieve,
  runHealth,
  unchangedExceptLastConfirmed,
  type AssetRef,
  type AuditEntry,
  type CapturedItem,
  type ConflictJudge,
  type ConflictJudgement,
  type DeriveInput,
  type DiscardedRecord,
  type Entity,
  type ExtractionInput,
  type GuardPolicy,
  type GuardResult,
  type HealthReport,
  type LinkPlan,
  type MergeJudge,
  type Model,
  type ModelExtraction,
  type RetrievalResult,
} from "@forge/core";
import { WEB_CAPTURE_CONNECTOR_ID, connectorById, detectConnector, type SourceConnector } from "@forge/ingest";
import {
  assetDirOf,
  confirmWithinDays,
  mintAssetId,
  newFrontMatter,
  parseAssetDocument,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
  type EventIR,
} from "@forge/schema";
import { assetRefsOf, openAssetLayer, rewriteFrontMatter, type AssetLayer, type InvalidAsset } from "./assets.ts";
import { openAuditLayer, type AuditLayer } from "./audit.ts";
import {
  CONFLICT_STATUS,
  RESOLUTIONS,
  openConflictLayer,
  writeConflicts,
  type ConflictIncumbentRecord,
  type ConflictLayer,
  type ConflictRecord as QueueRecord,
  type ConflictResolution,
  type Resolution,
} from "./conflicts.ts";
import {
  CANDIDATE_RECORD_VERSION,
  candidateIdOf,
  openInboxLayer,
  type CandidateRecord,
  type InboxLayer,
} from "./inbox.ts";
import { openIndexLayer, readIndexMarkdown, type IndexLayer, writeIndexMarkdown } from "./indexdb.ts";
import { ensureVault, stableJson, vaultPaths, type VaultPaths } from "./paths.ts";
import { buildSpanIndex } from "./spans.ts";
import { openSourceLayer, type ImportedSource, type SourceLayer, type SourceMeta } from "./sources.ts";

export interface CompileReport {
  sources: SourceMeta[];
  /** 每个来源产出的事件。排序过，是确定的。 */
  events: EventIR[];
  /** 被丢弃的记录：连接器层与 Normalizer 层的合并，**必须出现在报告里**。 */
  discarded: DiscardedRecord[];
  assets: AssetDoc[];
  invalid: InvalidAsset[];
}

/**
 * 一个来源的抽取单元：输入与产出**成对**存着。
 *
 * 为什么不让输入与产出分成两个平行的数组：那样任何一处错位都会静默地把
 * 甲来源的候选对着乙来源的输入去判，而结果不是崩溃——是**每一条都被判成编造**。
 * 这个 bug 在 Phase 4 真的发生过一次（见 `evals/regressions/0002`），
 * 表现是"模型抽出来的东西全被丢光，而报告里每一条看起来都很有道理"。
 */
export interface ExtractionUnit {
  input: ExtractionInput;
  result: ModelExtraction;
}

/** 一次抽取的**全部产出**。`extract()` 算完之后再写盘，所以它自己不碰盘。 */
export interface ExtractionRun {
  /** 逐来源的单元。排序过（按 source_id），于是报告可 diff（R6）。 */
  units: ExtractionUnit[];
  guard: GuardResult;
  /** 抛了错的来源。非空 = 这次跑不完整，调用方**不应该**落盘。 */
  failures: Array<{ sourceId: string; reason: string }>;
  /** 参与抽取的事件总数（报告用）。 */
  eventCount: number;
}

/** 候选落盘的结果，连同被跳过的（已经有一条指着同一处出处的资产了）。 */
export interface CandidateWriteReport {
  written: Array<{ path: string; created: boolean }>;
  /** 已经有资产指着同一处出处 —— 跳过，但要说出来。 */
  skippedExisting: CandidateRecord[];
  /**
   * 本次跑里内容重复的候选（同一个候选 ID 出现两次）。
   *
   * 必须单独计数，否则报告里的"落盘 N 条"会大于候选区里的文件数——
   * 而**数字对不上是用户唯一能发现采集漏了的信号**，报告自己先对不上就没救了。
   */
  duplicates: number;
}

export interface ExtractionOptions {
  model: Model;
  policy?: GuardPolicy;
}

/** 归并与冲突判定可以注入的两处模型接缝。两个都不给 = 只跑规则（默认，且完整可用）。 */
export interface JudgeOptions {
  merge?: MergeJudge;
  conflict?: ConflictJudge;
}

/** 一次健康检查的输入（S25）。`today` 必填——时钟是显式输入，core 里没有它。 */
export interface HealthOptions {
  /** `YYYY-MM-DD`。 */
  today: string;
  /** 要不要连索引层一起查。默认查。 */
  index?: boolean;
  /** 要不要查审计。默认查。 */
  audit?: boolean;
}

/**
 * 一次健康检查的**全部产出**。它是 `context` 的同构兄弟：
 * 判定与渲染在 `@forge/core`（纯函数），这里只负责把库读出来。
 *
 * `rendered` 是**报告正文**（markdown），`report` 是它的结构化形态——
 * 宿主（CLI / 定时任务 / 周报）要计数就取后者，要给人看就打印前者。
 * 两者同源，所以"报告里写的"与"退出码算的"不可能不一致。
 */
export interface HealthRun {
  report: HealthReport;
  rendered: string;
  /** 读不动的资产：它们**没有参与健康检查**。不静默跳过（与 `context` 同一条理由）。 */
  invalid: InvalidAsset[];
}

/** 一次周报的输入（S28）。 */
export interface WeeklyOptions {
  /** `YYYY-MM-DD`，窗口的末日（含）。 */
  today: string;
  /** 窗口长度，默认 7 天。 */
  days?: number;
}

export interface WeeklyRun {
  report: HealthReport;
  rendered: string;
  invalid: InvalidAsset[];
  /** 窗口 `[start, end]`，含首尾。 */
  window: { start: string; end: string };
  /**
   * 窗口内的审计条目。**`null` = 库里没有审计日志**（不是"这一周没动过"）。
   * 这两种情况在周报里必须长得不一样：把缺失的账本渲染成"很安静"，
   * 就是用一份空报告替它背书。
   */
  audit: AuditEntry[] | null;
}

/** `forge confirm` 的输入。三样都是人的判断，**都没有默认值**。 */
export interface ConfirmOptions {
  /** `YYYY-MM-DD`：人重新确认它的那一天。 */
  date: string;
  /** 为什么它仍然成立。**必填**——没有理由的确认等于一次点击。 */
  note: string;
  actor?: string | null;
  /** 审计条目要的时刻。由调用方注入（与 `mintUlid` 同一条理由）。 */
  atMs: number;
}

export type ConfirmResult =
  | { ok: true; path: string; previous: string | null; audit: AuditEntry }
  | { ok: false; reason: string };

/** 一次取用的输入。`budget` / `today` / `types` 全部透传给 `@forge/core` 的 `retrieve`。 */
export interface ContextOptions {
  query: string;
  /** token 预算。不给就用 core 的默认值。 */
  budget?: number;
  /** `YYYY-MM-DD`。不给 = **没有校验新鲜度**（不是"都新鲜"）。 */
  today?: string | null;
  types?: readonly AssetType[];
}

/**
 * 一次取用的**全部产出**。
 *
 * `violations` 是自证的结果，它**不是**报告的一部分：非空 = 注入块违反了自己的承诺
 * （超预算 / 注入了零分项 / 注入了没出处的），属于缺陷。
 * 把它交出来而不是"这里帮忙修一下"，理由与 `modelLeaks` 相同：
 * **关键性质要能被重新问一遍，而不是被就地抹平**（R8）。
 */
export interface ContextRun {
  result: RetrievalResult;
  rendered: string;
  violations: string[];
  /** 读不动的资产：它们**没有参与检索**，所以必须被看见（否则"少一截"与"没有"看起来一样）。 */
  invalid: InvalidAsset[];
}

/**
 * 一次采集的**上报**：扩展那边能给出的全部东西。
 *
 * 注意这里**没有 key**：键由 `capture()` 派生。让浏览器算键意味着"同一份逻辑跑在
 * 两个运行时里"，而浏览器执行不了这份 TypeScript（ADR-0011）——于是必然出现第二份实现，
 * 而两份实现漂移的方向永远是"浏览器那份更宽松"。
 */
export interface CaptureReport {
  host: string;
  label: string;
  page: string;
  items: Array<{ text?: unknown; author?: unknown; time?: unknown }>;
  /** 扩展自己发现的采不动的地方（选择器没命中之类）。它原样进结果。 */
  skipped?: string[];
}

/** 一次采集的结果。**每一个数字都要能被解释**：采到几条、新增几条、跳过几条、为什么。 */
export interface CaptureOutcome {
  ok: boolean;
  /** 没有新增时是 null——**空载荷不落盘**，否则 sources 层会长出一堆空来源。 */
  sourceId: string | null;
  created: boolean;
  received: number;
  fresh: number;
  duplicates: number;
  skipped: string[];
  /** 采集失败时的原因（host 缺失、形状不对…）。 */
  reason: string | null;
}

/**
 * 一次归并 + 冲突判定的**全部产出**。
 *
 * 与 `ExtractionRun` 同一个形状：算完之后由调用方决定写什么。
 * 这里多一个 `context`——它不是判定的一部分，而是"把判定写成队列记录"
 * 需要的边缘数据（现状快照、题面原样、候选 ID）。把它放在边缘而不是塞进
 * `ConflictCandidate`，是因为判定要能在没有文件系统的情况下被测。
 */
export interface JudgeRun {
  /** 参与判定的候选（来自候选区，排序过）。 */
  candidates: CandidateRecord[];
  assets: AssetRef[];
  plan: LinkPlan;
  entities: Entity[];
  judgement: ConflictJudgement;
  /**
   * 题面最集中的前几条。
   *
   * 它存在的理由是一条**已知的失败模式**：一个总给 `subject: "系统"` 的抽取器
   * 会让整个库塌成一个实体，于是每次确认都变成一次冲突（ADR-0025 的残余风险）。
   * 这条不进 CI（它是抽取质量），所以它必须出现在**报告**里——塌陷要能被看见。
   */
  crowdedSubjects: Array<{ subject: string; count: number }>;
  /** 每条冲突候选 → 写记录用的上下文。 */
  context: Map<string, { incumbent: ConflictIncumbentRecord; subject: string; candidateId: string }>;
}

/** 冲突落盘的结果，连同"队列里已经有、这次跳过"的那些。 */
export interface ConflictWriteReport {
  written: Array<{ path: string; created: boolean }>;
  /** 已经在队列里的（同一个 ID）。**不是错误**：它说明这条已经被人看过了。 */
  existing: QueueRecord[];
}

export interface ResolveOptions {
  decision: Resolution;
  /** `YYYY-MM-DD`：人做这个决定的那天。 */
  date: string;
  /** 为什么信这一侧。**必填**，理由见 `resolveConflict`。 */
  rationale: string;
  actor?: string | null;
  /** `replace` 时必填：新那条状态的置信度（人的判断，没有默认值）。 */
  confidence?: number;
  /** ULID 的时间部分（`replace` 要铸一个新状态 ID）。 */
  atMs: number;
  /** ULID 的随机部分。与 `promote` 同一条理由：随机性是显式的输入。 */
  random: Uint8Array;
}

export type ResolveResult =
  | {
      ok: true;
      record: QueueRecord;
      /** 真的改写了资产时才有：落下去的那一代新状态。 */
      applied: { asset_id: string; path: string; supersedes: string } | null;
    }
  | { ok: false; reason: string };

export interface Vault {
  paths: VaultPaths;
  sources: SourceLayer;
  assets: AssetLayer;
  index: IndexLayer;
  inbox: InboxLayer;
  conflicts: ConflictLayer;
  /**
   * 审计层（S27）。**它不是给宿主用的可选项**：`assets.writeAuthored` 要它才肯写。
   * 暴露出来是为了读（`forge audit --verify`、健康检查、周报）。
   */
  audit: AuditLayer;
  /** 导入一份来源。已经导入过的字节不会产生第二份来源（内容寻址）。 */
  importText(
    text: string,
    options: { originalName: string; connector?: SourceConnector } & AuditContext,
  ): ImportedSource;
  /** 来源 → 事件 IR。**不落盘**：事件是派生数据（ADR-0016）。 */
  derive(): { events: EventIR[]; discarded: DiscardedRecord[] };
  /**
   * 事件 → 逐来源的抽取输入。**不碰模型、不落盘。**
   *
   * 单独暴露的理由：`--record` 要先知道"有哪些问题要问"才能去录，
   * 而"问什么"完全由来源决定、与模型无关。没有这个入口时，
   * 录制那一趟就得先跑一遍空模型——那既多一次调用，也让"这次到底问了几次"
   * 变得说不清。
   */
  inputs(): ExtractionInput[];
  /** 幂等编译：重建索引层，可以对着同一个 vault 反复跑。 */
  compile(): CompileReport;
  /** 事件 → 候选断言 → 守卫判定。**不落盘**（见下方注释）。 */
  extract(options: ExtractionOptions): ExtractionRun;
  /**
   * 把守卫判成 `inbox` 的候选写进候选区。
   *
   * 审计条目的时刻来自 vault 的时钟（或 `options.atMs`）：**模型的脚印也要有日期**——
   * "这个候选是什么时候被提出来的"是复核它时第一个要问的问题。
   */
  recordCandidates(run: ExtractionRun, options?: AuditContext): CandidateWriteReport;
  /**
   * 候选区 × 现有资产 → 归并 + 冲突判定。**不落盘**（S18/S19：判定只出结论）。
   *
   * 它是 Phase 5 那条流水线的中间一段，形状与 `extract` 相同：
   * 全部算完再交给 `recordConflicts` 决定写什么。
   */
  judge(options?: JudgeOptions): JudgeRun;
  /** 把冲突判定写进队列。**一条冲突只会有一个文件**（ID 是内容寻址的）。 */
  recordConflicts(run: JudgeRun): ConflictWriteReport;
  /**
   * 取用：检索 + 渲染一段**预算内**的注入（S21）。
   *
   * 它是 `judge` / `extract` 的同构兄弟：**算完再交给调用方**，
   * 自己不改任何东西。判定在 `@forge/core` 的 `retrieve`（纯函数），
   * 这里只做三件边缘的事——把库扫出来、把事件从来源重推、把自证跑一遍。
   *
   * 为什么要把它收进 Vault，而不是让三个宿主各写一遍：
   * CLI、MCP server、浏览器扩展背后的 `forge serve` **必须给出同一段注入**，
   * 否则"为什么命令行里看到的和 Cursor 里看到的不一样"就变成了一个没人能回答的问题。
   */
  context(options: ContextOptions): ContextRun;
  /**
   * 增量采集的**落地**（S23）：把扩展报上来的一批记录变成一份来源。
   *
   * 它是 `importText` 的一个带判定的门面，判定三条：
   * **键由这里派生**（`captureKeyOf`，内容寻址）、**已经采过的丢掉**、
   * **空载荷不落盘**。浏览器那边因此不需要任何判断——它报，这里判。
   */
  capture(report: unknown): CaptureOutcome;
  /**
   * 人的决议。**这是全项目唯一一处能改写已有状态的地方**（ADR-0028），
   * 而它只接受显式的人类输入：决议、日期、理由。
   */
  resolveConflict(conflictId: string, options: ResolveOptions): ResolveResult;
  /**
   * 健康检查（S25）。**只读**：它不改任何东西，也不因为发现了问题就去修。
   *
   * 三个宿主（CLI / 定时任务 / 周报）走同一个入口，所以"命令行看到的"
   * 与"周报里写的"是同一份判定——与 `context()` 同一条理由。
   */
  health(options: HealthOptions): HealthRun;
  /**
   * 周报（S28）：这一周**库变成了什么样**（健康）+ **谁动了它**（审计）。
   *
   * 它与 `health` 的分工是"差异 vs. 快照"。窗口由 `today` 与 `days` 决定，
   * 两者都是输入——**周报里没有"生成时间"**，所以它可以被重印（R6）。
   */
  weekly(options: WeeklyOptions): WeeklyRun;
  /**
   * 重新确认一条 state 仍然成立（S26）。**这是人的动作，不是定时任务的**。
   *
   * 它只动 `last_confirmed` 一个字段：正文、出处、题面一个字节都不动
   * （由 `unchangedExceptLastConfirmed` 自证，写了别的东西就拒绝落盘）。
   * 理由见 ADR-0036：**机器自动刷新会让"过期"这件事永远不被看见**。
   */
  confirm(assetId: string, options: ConfirmOptions): ConfirmResult;
  /** 把一条候选确认成资产（**人工动作**，`forge inbox --promote`）。 */
  promote(candidateId: string, options: PromoteOptions): PromoteResult;
  /** 出处索引。`workspaces` 是 `file://` 的解析根。 */
  spanIndex(workspaces: string[]): ReturnType<typeof buildSpanIndex>;
}

/**
 * @param {unknown} value
 * @returns {CaptureReport | string} 形状不对时返回原因
 */
function asCaptureReport(value: unknown): CaptureReport | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "采集上报必须是一个对象";
  const record = value as Record<string, unknown>;

  const host = record["host"];
  if (typeof host !== "string" || host.length === 0) return "采集上报没有 host：出处要靠它说明「这是哪个站点上说的」";
  const page = record["page"];
  if (typeof page !== "string" || page.length === 0) return "采集上报没有 page：采的是哪一页是证据的一部分";

  const items = record["items"];
  if (!Array.isArray(items)) return "采集上报的 items 必须是数组";

  const skippedRaw = record["skipped"];
  const skipped = Array.isArray(skippedRaw) ? skippedRaw.filter((piece): piece is string => typeof piece === "string") : [];

  return {
    host,
    label: typeof record["label"] === "string" && record["label"].length > 0 ? record["label"] : host,
    page,
    items: items as CaptureReport["items"],
    skipped,
  };
}

/**
 * @param {string} root
 * @param {VaultOptions} [options]
 * @returns {Vault}
 */
export function openVault(root: string, options: VaultOptions = {}): Vault {
  const paths = vaultPaths(root);
  ensureVault(paths);
  const now = options.now ?? ((): number => Date.now());
  const stamp = (context?: AuditContext): number => context?.atMs ?? now();

  const sources = openSourceLayer(paths);
  const audit = openAuditLayer(paths);
  // 资产层拿到审计层才肯写（`writeAuthored` 的签名要一条审计条目）。
  // 这条依赖是**故意**的：没有它，"写资产"与"记审计"就退化成两件可以被拆开的事。
  const assets = openAssetLayer(paths, audit);
  const index = openIndexLayer(paths);
  const inbox = openInboxLayer(paths);
  const conflicts = openConflictLayer(paths);

  return {
    paths,
    sources,
    assets,
    index,
    inbox,
    conflicts,
    audit,

    importText(text, options) {
      const connector = options.connector ?? detectConnector(text);
      if (connector === null) {
        throw new Error(
          `认不出这份文件的格式。v0 只有一个连接器：官方数据导出（official-export）。` +
            `别的来源要各自的连接器——不猜格式，猜错会把噪声当证据。`,
        );
      }
      const outcome = sources.import(text, { connector, originalName: options.originalName });
      // 来源层是**最不可逆**的一步（只读、只追加，没有修改 API）。
      // 内容寻址命中（`created === false`）时不记：没有发生追加，记了会让日志里
      // 出现"导入了同一份字节 50 次"这类噪音。
      if (outcome.created) {
        audit.append({
          at: instantOf(stamp(options)),
          actor: options.actor ?? "cli",
          kind: AUDIT_KINDS.SOURCE_IMPORTED,
          subject: outcome.meta.id,
          detail: {
            connector: outcome.meta.connector,
            bytes: String(outcome.meta.bytes),
            original_name: outcome.meta.original_name,
          },
        });
      }
      return outcome;
    },

    derive() {
      const sourceMetas = sources.list();
      const inputs: DeriveInput[] = [];
      const discarded: DiscardedRecord[] = [];

      for (const meta of sourceMetas) {
        const record = sources.read(meta.id);
        if (record === null) {
          // meta 存在但 raw 读不到：这是 sources 层被外部动过的信号。宁可炸。
          throw new Error(`来源 ${meta.id} 的 meta.json 存在但 raw 读不到——sources/ 层被外部修改过。`);
        }
        const connector = connectorById(meta.connector);
        if (connector === null) {
          discarded.push({
            index: 0,
            key: meta.id,
            reason: `没有 id 为「${meta.connector}」的连接器：这份来源进不了编译（连接器是插件，删掉它等于删掉解释权）`,
          });
          continue;
        }
        // 连接器自己的 skipped 也进报告：静默丢弃会让"导入 1000 条"和"导入 999 条"看起来一样。
        for (const skipped of connector.parse(record.text).skipped) {
          discarded.push({ index: skipped.index, key: `${meta.id}/${skipped.index}`, reason: skipped.reason });
        }
        inputs.push({ id: meta.id, text: record.text, parse: (text) => connector.parse(text) });
      }

      const derived = deriveEvents(inputs);
      return { events: derived.events, discarded: [...discarded, ...derived.discarded] };
    },

    compile() {
      const sourceMetas = sources.list();
      const { events, discarded } = this.derive();

      const scan = assets.scan();
      // 索引层是**重建**的：没有"更新某一行"，因为这里全部可以重算（ADR-0015）。
      index.rebuild({ sources: sourceMetas, events, assets: scan.docs });
      writeIndexMarkdown(paths, emitIndex({ assets: scan.docs, events }));

      return {
        sources: sourceMetas,
        events,
        discarded,
        assets: scan.docs,
        invalid: scan.invalid,
      };
    },

    inputs() {
      const { events } = this.derive();

      // 按来源分组。排序过的键，所以报告顺序不依赖遍历顺序（R6）。
      const bySource = new Map<string, EventIR[]>();
      for (const event of events) {
        const list = bySource.get(event.source_id);
        if (list === undefined) bySource.set(event.source_id, [event]);
        else list.push(event);
      }

      return [...bySource.keys()].sort().map((sourceId) => ({ sourceId, events: bySource.get(sourceId) ?? [] }));
    },

    extract(options) {
      const inputs = this.inputs();

      const units: ExtractionUnit[] = [];
      const failures: Array<{ sourceId: string; reason: string }> = [];
      for (const input of inputs) {
        try {
          units.push({ input, result: extractFromModel(input, options.model) });
        } catch (error) {
          // 抽取器抛错**不吞**：一次"什么都没抽出来"的静默成功，
          // 与"模型认为这段没有值得记的东西"在报告里长得一模一样。
          failures.push({
            sourceId: input.sourceId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // **逐来源判**。守卫要用"这批候选当初的输入"去复核出处，
      // 而各来源的 source_id 不同：把候选合起来对着一个假的合并输入判，
      // 结果是每一条都被判成"引用了没看见过的来源"——全都丢光，
      // 而报告里每一条的理由看起来都很有道理。这个 bug 真发生过（regressions/0002）。
      const policy = options.policy ?? DEFAULT_GUARD_POLICY;
      const guard = mergeGuards(
        units.map((unit) => guardCandidates(unit.input, unit.result.candidates, policy)),
      );

      return {
        units,
        guard,
        failures,
        eventCount: inputs.reduce((sum, input) => sum + input.events.length, 0),
      };
    },

    recordCandidates(run, options = {}) {
      // 候选区**只收 `inbox` 的**。`admitted` 落到这里来是没有意义的：
      // 它意味着守卫认为这条可以直接进正式资产，而那需要一条
      // "候选 → 资产"的渲染与人工确认通路（Phase 5 的队列）。
      // 把 admitted 静默塞进候选区，会掩盖"守卫的判定没人接"这件事。
      const existing = new Set(
        this.assets
          .scan()
          .docs.map((doc) => assetKey(doc.frontMatter.type, doc.frontMatter.sources)),
      );

      const written: Array<{ path: string; created: boolean }> = [];
      const skippedExisting: CandidateRecord[] = [];
      const seen = new Set<string>();
      let duplicates = 0;

      for (const decision of run.guard.inboxed) {
        const unit = run.units.find((candidateUnit) =>
          candidateUnit.result.candidates.includes(decision.candidate),
        );
        const record: CandidateRecord = {
          candidate_version: CANDIDATE_RECORD_VERSION,
          candidate_id: candidateIdOf(decision.candidate),
          type: decision.candidate.type,
          title: decision.candidate.title,
          subject: decision.candidate.subject,
          body: decision.candidate.body,
          sources: decision.candidate.sources,
          confidence: decision.candidate.confidence,
          origin: decision.candidate.origin,
          harness: unit?.result.harness ?? "",
          model: unit?.result.model ?? "",
        };

        // 本次跑里内容重复：候选 ID 是内容寻址的，两条一字不差的候选是**同一个**候选。
        // 不单独数出来的话，报告里的"落盘 N 条"会比候选区里的文件数大。
        if (seen.has(record.candidate_id)) {
          duplicates += 1;
          continue;
        }
        seen.add(record.candidate_id);

        // 已经有一条资产指着同一处出处 → 这条候选没有新信息。
        // 不跳过的话，`extract` 会因为"已经确认过的资产"反复往候选区里塞回同一条，
        // 而一个只增不减的候选区会让人学会无视它。
        if (existing.has(assetKey(record.type, record.sources))) {
          skippedExisting.push(record);
          continue;
        }

        written.push(this.inbox.put(record));
      }

      // 一次跑记**一条**（不是每条候选一条）：人问的是"这个模型这次提了什么"，
      // 而每条候选都有自己的 ID 与文件，详情不必在审计里再抄一遍。
      // 什么都没落盘时不记——一条"什么都没发生"的记录只会把日志灌满。
      if (written.length > 0) {
        const models = [...new Set(run.units.map((unit) => unit.result.model).filter((id) => id.length > 0))].sort();
        audit.append({
          at: instantOf(stamp(options)),
          actor: options?.actor ?? "cli",
          kind: AUDIT_KINDS.CANDIDATES_RECORDED,
          subject: `_inbox/${String(written.length)} 条`,
          detail: {
            written: String(written.length),
            skipped_existing: String(skippedExisting.length),
            duplicates: String(duplicates),
            model: models.join("、"),
          },
        });
      }

      return { written, skippedExisting, duplicates };
    },

    judge(options = {}) {
      // 候选来自**候选区**，不是"这一批刚抽出来的"：队列审理的是
      // "已经躺在那儿等人看的东西"，而不是"刚才那一跑的产出"。两者的区别很实在——
      // 前者是人已经见过的一批，后者每次跑都不一样。
      const candidates = this.inbox.scan().records;
      const refs = assetRefsOf(this.assets.scan().docs);

      const plan = linkCandidates({ candidates, assets: refs, ...(options.merge === undefined ? {} : { judge: options.merge }) });
      const judgement = judgeConflicts({
        candidates,
        assets: refs,
        ...(options.conflict === undefined ? {} : { judge: options.conflict }),
      });

      // 每一条冲突要能写成一条记录：现状的快照、题面的原样写法、新证据的候选 ID。
      // 这些都不进判定（判定只认纯数据），所以它们在**边缘**被补齐。
      const context = new Map<string, { incumbent: ConflictIncumbentRecord; subject: string; candidateId: string }>();
      for (const conflict of judgement.conflicts) {
        const asset = refs.find((ref) => ref.id === conflict.incumbent.assetId);
        if (asset === undefined) continue;
        // 题面取**新证据侧的原样写法**：落下去的那一代状态讲的就是这件事，
        // 而它必须是人能读的写法（键是折叠过的，见 ADR-0025）。
        const subject = conflict.incoming.candidate.subject ?? "";
        if (subject.length === 0) continue;
        context.set(conflict.key, {
          incumbent: {
            asset_id: asset.id,
            path: asset.path,
            status: asset.status,
            label: asset.path,
            value: conflict.incumbent.value,
            sources: conflict.incumbent.sources,
          },
          subject,
          candidateId: candidateIdOf(conflict.incoming.candidate),
        });
      }

      return {
        candidates,
        assets: refs,
        plan,
        entities: entitiesOf(plan, refs),
        judgement,
        crowdedSubjects: crowdedSubjectsOf(candidates),
        context,
      };
    },

    recordConflicts(run) {
      return writeConflicts(this.conflicts, run.judgement, run.context);
    },

    capture(report) {
      const parsed = asCaptureReport(report);
      if (typeof parsed === "string") {
        return {
          ok: false,
          sourceId: null,
          created: false,
          received: 0,
          fresh: 0,
          duplicates: 0,
          skipped: [],
          reason: parsed,
        };
      }

      // 已经采过的键：从**已有的采集来源**里重新解析出来。
      // 为什么每次都重算而不是存一份"已见集合"：存下来的那份会与 sources 层漂移
      // （比如有人手动删了一份来源），而漂移的表现是"同一条被采了两次"——
      // 库里多一条重复的记录，比多花几十毫秒难查得多。
      const seen = new Set<string>();
      for (const meta of this.sources.list()) {
        if (meta.connector !== WEB_CAPTURE_CONNECTOR_ID) continue;
        const stored = this.sources.read(meta.id);
        if (stored === null) continue;
        const connector = connectorById(meta.connector);
        if (connector === null) continue;
        for (const record of connector.parse(stored.text).records) seen.add(record.key);
      }

      const skipped = [...(parsed.skipped ?? [])];
      const keyed: CapturedItem[] = [];
      for (const [index, item] of parsed.items.entries()) {
        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (text.length === 0) {
          skipped.push(`第 ${String(index + 1)} 条没有正文`);
          continue;
        }
        const time = typeof item.time === "string" ? item.time : null;
        if (time === null) {
          // 时间缺了这条进不了事件 IR（它要有 `occurred_at`）。
          // **不替它编一个**：编出来的时间会变成证据的一部分，而它是假的。
          skipped.push(`第 ${String(index + 1)} 条没有时间：页面上要能取到时间，或者由扩展把相对时间折成 ISO`);
          continue;
        }
        keyed.push({
          key: captureKeyOf({ host: parsed.host, rawKey: null, text }),
          text,
          author: typeof item.author === "string" && item.author.length > 0 ? item.author : null,
          time,
        });
      }

      const { fresh, duplicates } = freshItems(keyed, seen);
      const payload = buildCapturePayload({
        host: parsed.host,
        label: parsed.label,
        page: parsed.page,
        items: fresh,
      });
      if (payload === null) {
        // 没有新东西 = **不落盘**。一份空来源与"这个站点没有新东西"在下游看起来一样，
        // 而 sources 层是只追加的：多出来的那份空来源永远删不掉。
        return {
          ok: true,
          sourceId: null,
          created: false,
          received: parsed.items.length,
          fresh: 0,
          duplicates,
          skipped,
          reason: null,
        };
      }

      const imported = this.importText(stableJson(payload), {
        originalName: `web-capture:${parsed.label} @ ${parsed.page}`,
      });
      return {
        ok: true,
        sourceId: imported.meta.id,
        created: imported.created,
        received: parsed.items.length,
        fresh: fresh.length,
        duplicates,
        skipped,
        reason: null,
      };
    },

    context(options) {
      // 读不动的资产不静默跳过：它们会让检索**安静地**少一截，
      // 而"少一截"与"库里没有"在输出上长得一模一样。
      const scan = this.assets.scan();
      // 事件从**来源重新推导**，不读索引（与 emit 同一条理由：索引是可重建的缓存）。
      const { events } = this.derive();
      const result = retrieve({
        query: options.query,
        assets: scan.docs,
        events,
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        today: options.today ?? null,
        ...(options.types === undefined ? {} : { types: options.types }),
      });
      const rendered = renderInjection(result);
      return { result, rendered, violations: retrievalViolations(result, rendered), invalid: scan.invalid };
    },

    health(options) {
      const scan = this.assets.scan();
      // 读不动的资产**没有参与任何检查**：它们会让健康报告安静地少一截，
      // 而"少一截"与"库里没有"在报告上长得一模一样（与 `context` 同一条理由）。
      const { events } = this.derive();
      const sourceMetas = this.sources.list();

      const facts: Parameters<typeof runHealth>[0] = {
        assets: scan.docs,
        today: options.today,
        events,
      };
      if (options.index !== false) {
        facts.index = {
          indexed: indexFactsOf(this.index),
          actual: { sources: sourceMetas.length, events: events.length },
          indexMarkdown: readIndexMarkdown(paths),
        };
      }
      if (options.audit !== false) {
        facts.audit = this.audit.read();
      }

      const report = runHealth(facts);
      return { report, rendered: renderHealthReport(report), invalid: scan.invalid };
    },

    weekly(options) {
      const days = options.days ?? 7;
      const start = shiftDays(options.today, -(days - 1));
      const scan = this.assets.scan();
      const { events } = this.derive();

      const report = runHealth({
        assets: scan.docs,
        today: options.today,
        events,
        index: {
          indexed: indexFactsOf(this.index),
          actual: { sources: this.sources.list().length, events: events.length },
          indexMarkdown: readIndexMarkdown(paths),
        },
        audit: this.audit.read(),
      });

      // **没有日志文件 ≠ 这一周没动过**。这两种情况必须分开，
      // 否则一份缺失的账本会被渲染成"这一周很安静"。
      const present = this.audit.exists();
      const inWindow = present
        ? this.audit
            .read()
            .entries.filter((entry) => entry.at.slice(0, 10) >= start && entry.at.slice(0, 10) <= options.today)
        : null;

      return {
        report,
        rendered: renderWeeklyReport({ report, audit: inWindow, weekStart: start, weekEnd: options.today }),
        invalid: scan.invalid,
        window: { start, end: options.today },
        audit: inWindow,
      };
    },

    confirm(assetId, options) {
      if (options.note.trim().length === 0) {
        return {
          ok: false,
          reason:
            "确认必须带 note：没有理由的确认等于一次点击。\n" +
            "  它是留给下一个读它的人的——他要知道你当时凭什么认为它仍然成立。\n" +
            "  （note 进审计，**不进资产**：这条状态的正文与出处一个字节都不会动。）",
        };
      }

      const doc = this.assets.scan().docs.find((candidate) => candidate.frontMatter.id === assetId);
      if (doc === undefined) {
        return { ok: false, reason: `库里没有 ${assetId}` };
      }
      if (confirmWithinDays(doc.frontMatter.type) === null) {
        return {
          ok: false,
          reason:
            `${doc.path} 是 ${doc.frontMatter.type} 型，**它不会过期**（分类法里没有给这种类型定窗口），` +
            `所以"重新确认"对它没有意义。要改它说的是什么，就走一次状态替换。`,
        };
      }

      const previous = doc.frontMatter.last_confirmed;
      if (previous !== null && options.date < previous) {
        return {
          ok: false,
          reason:
            `日期 ${options.date} 早于当前的 last_confirmed（${previous}）：` +
            `确认只能把"最后一次看过它"往后推。往回填会让这条状态看起来比实际更旧。`,
        };
      }

      const next = { ...doc.frontMatter, last_confirmed: options.date };
      // 自证：这次写入**只准动 last_confirmed**。写别的东西就拒绝落盘——
      // 与 `modelLeaks` / `retrievalViolations` 同一条思路：
      // **关键性质要能被重新问一遍，而不是靠读代码相信它**。
      const drifted = unchangedExceptLastConfirmed(doc.frontMatter, next);
      if (drifted.length > 0) {
        return { ok: false, reason: `确认只许改 last_confirmed，但这次改动还会动：${drifted.join("、")}——拒绝落盘` };
      }

      // 正文、出处、题面**原样**：`rewriteFrontMatter` 用的是同一个 `doc.body`，
      // 而 `next` 是在原 front-matter 上展开的（不是新造一个）。
      const outcome = rewriteFrontMatter(this.assets, doc, () => next, {
        at: instantOf(options.atMs),
        actor: options.actor ?? "cli",
        kind: AUDIT_KINDS.STATE_CONFIRMED,
        subject: doc.frontMatter.id,
        detail: {
          from: previous ?? "(从未确认)",
          to: options.date,
          note: options.note,
        },
      });

      return { ok: true, path: outcome.path, previous, audit: outcome.audit };
    },

    resolveConflict(conflictId, options) {
      const record = this.conflicts.read(conflictId);
      if (record === null) {
        return { ok: false, reason: `队列里没有 ${conflictId}` };
      }
      if (record.status === CONFLICT_STATUS.RESOLVED) {
        const applied = record.resolution?.applied;
        return {
          ok: false,
          reason:
            `这条已经判过了（${record.resolution?.decision ?? "?"}，${record.resolution?.date ?? "?"}）` +
            `——${applied === null || applied === undefined ? "没有写任何资产" : `落下了 ${applied.asset_id}`}。` +
            `队列记录不改写历史：要重新判，就先接受上一次的记录在那儿。`,
        };
      }
      if (options.rationale.trim().length === 0) {
        return {
          ok: false,
          reason:
            "决议必须带 rationale：没有理由的判定等于一次点击。\n" +
            "  这条记录是留给下一个读它的人的——他要知道当时凭什么信了这一侧。",
        };
      }

      if (options.decision !== RESOLUTIONS.REPLACE) {
        const resolution: ConflictResolution = {
          decision: options.decision,
          date: options.date,
          rationale: options.rationale,
          actor: options.actor ?? null,
          applied: null,
        };
        const status = options.decision === RESOLUTIONS.DEFER ? CONFLICT_STATUS.DEFERRED : CONFLICT_STATUS.RESOLVED;
        this.conflicts.markResolved(conflictId, resolution, status);
        return { ok: true, record: { ...record, status, resolution }, applied: null };
      }

      // ── replace：唯一会改写已有资产的那条路（ADR-0028）──────────────────
      if (options.confidence === undefined) {
        return { ok: false, reason: "replace 必须给 confidence：它是你对新那条状态的判断，没有默认值。" };
      }
      if (!Number.isFinite(options.confidence) || options.confidence < 0 || options.confidence > 1) {
        return { ok: false, reason: `confidence 要在 0..1 之间，收到 ${String(options.confidence)}` };
      }

      const incumbent = this.assets
        .scan()
        .docs.find((doc) => doc.frontMatter.id === record.incumbent.asset_id);
      if (incumbent === undefined) {
        return {
          ok: false,
          reason:
            `记录指向的现状 ${record.incumbent.asset_id}（${record.incumbent.path}）现在读不到了。` +
            `它可能在排队期间被人删了或改了名——先去看它，再决定这条记录怎么处置。`,
        };
      }
      if (incumbent.frontMatter.status !== "active") {
        return {
          ok: false,
          reason:
            `${record.incumbent.path} 现在的状态是 ${incumbent.frontMatter.status}，不是 active。` +
            `它已经在排队期间被处理过了——再替换一次会在同一个题面上留下第二对 active。`,
        };
      }
      const lastConfirmed = incumbent.frontMatter.last_confirmed;
      if (lastConfirmed !== null && options.date < lastConfirmed) {
        return {
          ok: false,
          reason:
            `日期 ${options.date} 早于 ${record.incumbent.path} 的 last_confirmed（${lastConfirmed}）：` +
            `时间线上会出现"新状态从过去就开始生效"。换一个不早于它的日期。`,
        };
      }

      const candidate = this.inbox.read(record.incoming.candidate_id);
      if (candidate === null) {
        return {
          ok: false,
          reason:
            `这条冲突依据的候选 ${record.incoming.candidate_id} 已经不在候选区了。` +
            `旧正文不能凭记录里的归一化文本重建（那会改掉原文的排版）——` +
            `先弄清它是被确认了、还是被删了，再决定这条记录怎么处置。`,
        };
      }

      const frontMatter = newFrontMatter("state", mintAssetId("state", options.atMs, options.random), options.date);
      frontMatter.last_confirmed = options.date;
      frontMatter.supersedes = incumbent.frontMatter.id;
      frontMatter.subject = record.subject;
      // 出处**原样**从候选搬过来：它是这条新状态之所以能立起来的唯一理由。
      frontMatter.sources = [...candidate.sources];
      frontMatter.confidence = options.confidence;

      const doc: AssetDoc = {
        path: `assets/${assetDirOf("state")}/${frontMatter.id}.md`,
        frontMatter,
        body: candidate.body,
        raw: renderAssetDocument(frontMatter, candidate.body),
      };

      const written = this.assets.writeAuthored(doc, {
        at: instantOf(options.atMs),
        actor: options.actor ?? "cli",
        kind: AUDIT_KINDS.CONFLICT_RESOLVED,
        subject: frontMatter.id,
        detail: {
          conflict_id: conflictId,
          decision: RESOLUTIONS.REPLACE,
          supersedes: incumbent.frontMatter.id,
          rationale: options.rationale,
        },
      });
      // 旧那一代**只改状态**：正文与出处一个字节都不动，于是它仍然可读、可核对。
      // 它是**另一次写入**，所以有**另一条审计条目**——"每一次写都有见证人"
      // 这条性质不能因为"它们属于同一次判决"就打折。
      rewriteFrontMatter(
        this.assets,
        incumbent,
        (front) => ({ ...front, status: "superseded" }),
        {
          at: instantOf(options.atMs),
          actor: options.actor ?? "cli",
          kind: AUDIT_KINDS.CONFLICT_RESOLVED,
          subject: incumbent.frontMatter.id,
          detail: {
            conflict_id: conflictId,
            decision: RESOLUTIONS.REPLACE,
            replaced_by: frontMatter.id,
            rationale: options.rationale,
          },
        },
      );

      // 候选成了资产，就该离开候选区——与 `promote` 同一条理由：
      // 留着它会让下一次 `forge extract` 把它再抽一遍。
      this.inbox.remove(record.incoming.candidate_id);

      const resolution: ConflictResolution = {
        decision: RESOLUTIONS.REPLACE,
        date: options.date,
        rationale: options.rationale,
        actor: options.actor ?? null,
        applied: { asset_id: frontMatter.id, path: written.path, supersedes: incumbent.frontMatter.id },
      };
      this.conflicts.markResolved(conflictId, resolution, CONFLICT_STATUS.RESOLVED);

      return {
        ok: true,
        record: { ...record, status: CONFLICT_STATUS.RESOLVED, resolution },
        applied: resolution.applied,
      };
    },

    promote(candidateId, options) {
      const candidate = inbox.read(candidateId);
      if (candidate === null) {
        return { ok: false, reason: `候选区里没有 ${candidateId}` };
      }

      // 已经有一条资产指着同一处出处 → 拒绝。
      // 这条检查防的是"同一条断言被确认两次"：第二次确认不会产生第二条资产，
      // 它只会产生两份指向同一处证据的记录，而将来改一处就要改两处。
      const clash = this.assets
        .scan()
        .docs.find(
          (doc) =>
            doc.frontMatter.type === candidate.type &&
            assetKey(doc.frontMatter.type, doc.frontMatter.sources) ===
              assetKey(candidate.type, candidate.sources),
        );
      if (clash !== undefined) {
        return {
          ok: false,
          reason:
            `已经有一条资产指着同一处出处了：${clash.path}。` +
            `再去确认一遍不会产生第二条资产，只会让同一处证据有两份记录。`,
        };
      }

      const frontMatter = newFrontMatter(
        candidate.type,
        mintAssetId(candidate.type, options.atMs, options.random),
        options.date,
      );
      // 出处**原样搬过来**：它是这条候选之所以能被确认的唯一理由。
      // 在这里"顺手规范化一下"就会让资产与候选指向两个不同的字符串。
      frontMatter.sources = [...candidate.sources];
      // 题面也原样搬过来（ADR-0025）：它决定了这条资产将来会不会被认出来
      // "有人推翻了它"。`state` 缺了它会被审核报 REQUIRED_FIELD_MISSING——
      // 那是行动指令，不是可以糊过去的东西。
      frontMatter.subject = candidate.subject;
      // 置信度由人给，**没有默认值**：默认值会让"确认"退化成一次点击，
      // 而"多确定才算确定"是这份产品里最像人的那部分判断。
      frontMatter.confidence = options.confidence;

      // 正文**原样复制，不补模板骨架**。补骨架（给每个必填章节塞一句"待补"）
      // 会让这份草稿立刻通过 `forge lint` —— 一个"什么检查都过了但什么都没写"的绿灯。
      // 宁可让 lint 明确报 `REQUIRED_SECTION_MISSING`：那是行动指令。
      const body = candidate.body;
      const doc: AssetDoc = {
        path: `assets/${assetDirOf(candidate.type)}/${frontMatter.id}.md`,
        frontMatter,
        body,
        raw: renderAssetDocument(frontMatter, body),
      };

      const written = assets.writeAuthored(doc, {
        at: instantOf(options.atMs),
        actor: options.actor ?? "cli",
        kind: AUDIT_KINDS.ASSET_PROMOTED,
        subject: frontMatter.id,
        detail: {
          candidate_id: candidateId,
          type: candidate.type,
          origin: candidate.origin,
          confidence: String(options.confidence),
          date: options.date,
        },
      });
      // 确认之后把候选移出候选区：留着它，下一次 `forge extract` 会把它再抽一遍，
      // 于是候选区里长期躺着一批"已经确认过"的东西。
      inbox.remove(candidateId);
      return { ok: true, asset: written };
    },

    spanIndex(workspaces) {
      return buildSpanIndex({ sources, workspaces });
    },
  };
}

/**
 * 一条审计记录要的调用上下文。`atMs` 不给时用 vault 的时钟（见 `VaultOptions.now`）。
 *
 * 时钟是**在边界上注入的**，不是藏在校验逻辑里的 `Date.now()`：
 * `packages/core` 里没有时钟，`packages/store` 里也没有——它只持有宿主在
 * `openVault` 时交进来的那一个。于是"冻住时间跑两次、得到同样的字节"
 * 这件事在测试里是一行代码，而不是一句祈祷。
 */
export interface AuditContext {
  /** 审计条目的时刻。不给就用 vault 的时钟。 */
  atMs?: number;
  /** 谁做的。不给就是 `cli`——**但那时报告里就不能说"某人做的"**。 */
  actor?: string | null;
}

/** `openVault` 的可选注入点。目前只有时钟一个——因为它是唯一一个"必须是输入"的东西。 */
export interface VaultOptions {
  /**
   * 时钟。审计条目的时刻从这里来。
   *
   * 默认是 `Date.now`：**这个默认是边界上的**（`openVault` 是边缘，与
   * `apps/cli` 读环境变量同级），而不是在某个判定函数里偷偷看一眼表。
   */
  now?: () => number;
}

/**
 * 把毫秒折成 ISO 时刻（UTC，毫秒精度）。
 *
 * 单独一个函数而不是各处 `new Date(...).toISOString()`：审计的排序依赖
 * **同一个格式**——一个地方写 `toISOString()`、另一个地方写本地时间字符串，
 * 链的"时间不倒流"那条检查就会开始误报。
 *
 * @param {number} atMs
 * @returns {string}
 */
function instantOf(atMs: number): string {
  return new Date(atMs).toISOString();
}

/**
 * `YYYY-MM-DD` 加减天数。用于周报窗口——**它与 `today` 同源**，
 * 所以窗口不依赖"跑的那一刻是哪一天"。
 *
 * @param {string} date
 * @param {number} days
 * @returns {string}
 */
function shiftDays(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) return date;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 索引层现在记着的东西。读不出来（没编译过 / 格式版本对不上）时返回 null——
 * 那是"索引不存在"，与"索引一致"必须长得不一样（ADR-0009）。
 *
 * @param {IndexLayer} index
 * @returns {{sources: number; events: number; assets: number; assetIds: string[]} | null}
 */
function indexFactsOf(
  index: IndexLayer,
): { sources: number; events: number; assets: number; assetIds: string[] } | null {
  const counts = index.counts();
  if (counts === null) return null;
  return { ...counts, assetIds: index.assetIds() };
}

/**
 * 把逐来源的守卫结果合成一份。
 *
 * 合成的是**已判定的结果**，不是"把候选合起来再判一遍"——后者会丢掉
 * "这条候选当初是对着哪个输入判的"这个信息（见 `extract()` 里的注释）。
 * 每一段结果各自已排过序，所以拼接之后仍然是确定的（R6）。
 *
 * @param {GuardResult[]} parts
 * @returns {GuardResult}
 */
function mergeGuards(parts: GuardResult[]): GuardResult {
  return {
    admitted: parts.flatMap((part) => part.admitted),
    inboxed: parts.flatMap((part) => part.inboxed),
    rejected: parts.flatMap((part) => part.rejected),
  };
}

/**
 * 题面最集中的前几条候选。
 *
 * 只在计数 > 1 的题面里取名次：一片全是 1 的分布说明不了任何事，
 * 而"三条以上候选挤在同一个题面下"正是**题面塌陷**的第一道信号——
 * 一个总给 `subject: "系统"` 的抽取器会让整个库变成一个实体，
 * 于是每次确认都变成一次冲突（ADR-0025 的残余风险）。
 * 它不进 CI（那是抽取质量，归尺子），所以它必须出现在报告里。
 *
 * @param {Array<{subject: string | null}>} candidates
 * @returns {Array<{subject: string; count: number}>}
 */
function crowdedSubjectsOf(candidates: Array<{ subject: string | null }>): Array<{ subject: string; count: number }> {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = normalizeSubjectKey(candidate.subject);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([subject, count]) => ({ subject, count }))
    // 先按数量、再按题面：排序键必须完全确定，否则两次运行会打出不同的行（R6）。
    .sort((a, b) => (b.count === a.count ? (a.subject < b.subject ? -1 : 1) : b.count - a.count))
    .slice(0, 3);
}

/**
 * 一条断言的身份：`<type>@<出处列表>`。
 * 出处排序后拼——`["a","b"]` 与 `["b","a"]` 是同一条断言，
 * 让它们看起来不同的后果是重复检测静默失效（ADR-0013 同一条理由）。
 *
 * @param {AssetType} type
 * @param {string[]} sources
 * @returns {string}
 */
function assetKey(type: AssetType, sources: readonly string[]): string {
  return `${type}@${[...sources].sort().join(" ")}`;
}

/**
 * 把一条候选确认成资产。**这是产品里唯一一个"候选 → 资产"的入口**，
 * 而它必须由人来触发：`forge inbox --promote`。
 *
 * 参数里的 `atMs` / `random` 由调用方注入（与 `mintUlid` 同一条理由）：
 * 时间和随机性是显式的输入，不是一个藏在函数里的默认。
 */
export interface PromoteOptions {
  /** `YYYY-MM-DD`，会成为 `created`。值得记的是"人确认它的那天"，不是"命令跑的那天"。 */
  date: string;
  /** 0..1，**必填**：见 `promote` 里的注释。 */
  confidence: number;
  /** 谁确认的。它会进审计——报告里要能回答"这条是谁放进去的"。 */
  actor?: string | null;
  /** ULID 的时间部分。 */
  atMs: number;
  /** ULID 的随机部分。 */
  random: Uint8Array;
}

export type PromoteResult =
  | { ok: true; asset: { path: string; created: boolean } }
  | { ok: false; reason: string };

/**
 * 从**仓库**里读资产（ADR-0012：约定即集合——任何带 front-matter 的 markdown 都是资产，
 * `schema/` 除外）。CI 用这个函数，`forge lint` 用 vault 版；
 * 两处必须是**同一份判定**，否则会出现"本地过、CI 挂"。
 *
 * 为什么"约定即集合"而不是"维护一份资产清单"：清单**会漏**，
 * 而漏登记的资产不受任何检查、也不发出任何信号——静默失败不是闸门（ADR-0012）。
 *
 * @param {string} root
 * @param {{exclude?: readonly string[]}} [options]
 * @returns {{docs: AssetDoc[]; invalid: InvalidAsset[]}}
 */
export function readRepoAssets(
  root: string,
  options: { exclude?: readonly string[] } = {},
): { docs: AssetDoc[]; invalid: InvalidAsset[] } {
  const exclude = new Set(options.exclude ?? DEFAULT_REPO_EXCLUDES);
  const docs: AssetDoc[] = [];
  const invalid: InvalidAsset[] = [];

  const walk = (relativeDir: string): void => {
    const full = relativeDir.length === 0 ? root : join(root, relativeDir);
    let entries;
    try {
      entries = readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    // 排序：`readdirSync` 的顺序不是契约，而遍历顺序会影响报告顺序（R6）。
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relativePath = relativeDir.length === 0 ? entry.name : `${relativeDir}/${entry.name}`;
      if (exclude.has(relativePath) || exclude.has(entry.name)) continue;
      if (entry.isDirectory()) {
        walk(relativePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

      const text = readFileSync(join(root, relativePath), "utf8");
      // 只把**带 front-matter 的** markdown 当资产：投影（AGENTS.md）不带，因此不会被误判。
      if (!text.startsWith("---\n")) continue;

      const parsed = parseAssetDocument(relativePath, text);
      if (parsed.ok) docs.push(parsed.doc);
      else invalid.push({ path: relativePath, reason: parsed.reason });
    }
  };

  walk("");
  return { docs, invalid };
}

/** 检索范围排除。`schema/` 是宪法不是资产；`data/` 是用户数据（R1）。 */
export const DEFAULT_REPO_EXCLUDES: readonly string[] = [
  "schema",
  // `spec/` 是公开规范仓的导出源（白名单在 public-export.json），不是本仓库的资产库。
  // 不排除它，示例账本会被 readRepoAssets 当成正式资产，进而把 bootstrap 的
  // "44 条 ADR" 变成 "48 条资产"，并让 listing/demo 产生产物漂移。
  "spec",
  "data",
  "node_modules",
  "dist",
  "build",
  ".git",
  ".turbo",
  ".claude",
  ".githooks",
  ".github",
  // Phase 8 的两个对外产物是**投影**，不是资产：
  // `listing/` 里的 `SKILL.md` 以 `---` 开头（Skill 的 front-matter），
  // 如果不排除，它会被 `readRepoAssets` 当成一条 front-matter 资产，
  // 然后在 `forge lint --repo` 与出处闸门里报「读不动」。
  // `demo/` 目前没有带 front-matter 的 markdown，但同样不该进入检索语料。
  "listing",
  "demo",
];
