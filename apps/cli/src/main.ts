#!/usr/bin/env node
/**
 * `forge` CLI —— apps 只做"把 core 接到某个宿主"（directory.md 反模式 3）。
 *
 * 这个文件里**没有判定逻辑**：它解析参数、调 `@forge/core` 与 `@forge/store`、
 * 把结果打到 stdout、把退出码设对。任何"到底算不算违规"的判断都不许写在这里——
 * 写了第二天就得把同一段逻辑抄到 MCP server 和桌面端，然后三份实现开始漂移。
 *
 * 五条命令对应 implement2.md 的 S11 与 S15–S16：
 *   compile  来源 → 事件 IR → 事件资产 + 重建索引（幂等）
 *   lint     资产 → 违规列表（与闸门同一份纯函数）
 *   emit     资产 → AGENTS.md / INDEX.md / adr/（逐字节确定）
 *   extract  事件 → 模型抽取 → 守卫 → 候选区 `_inbox/`（**模型只做抽取**）
 *   inbox    候选区：列出 / 把一条确认成资产
 *
 * `compile / lint / emit` 全程**不需要 API key**。`extract` 也只有两种情况：
 * 对着录像跑（`--cassette`，不需要 key）或者当场录一段（`--record`，需要 key）。
 * 这不是"暂时没有"，而是架构纪律——它划开了"工具"和"玩具"。
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AUDIT_KINDS,
  DEFAULT_BUDGET_TOKENS,
  EXTRACTION_HARNESS,
  MIN_BUDGET_TOKENS,
  buildExtractionRequest,
  checkFreshness,
  emitDemo,
  emitEvalCases,
  emitLibrary,
  emitListing,
  emitSkill,
  evalExportFile,
  evaluateBootstrap,
  formatViolation,
  judgeLibrary,
  modelLeaks,
  renderBootstrapReport,
  sortViolations,
  teamStatusFromConfig,
  stalePaths,
  type BootstrapArtifact,
  type EvalReviewInput,
  type SeedRulesInput,
  type Model,
  type Violation,
} from "@forge/core";
import {
  ASSET_TYPES,
  SCHEMA_VERSION,
  isAssetType,
  type AssetDoc,
  type AssetType,
  type EventIR,
} from "@forge/schema";
import {
  CASSETTE_VERSION,
  CONFLICT_STATUS,
  RESOLUTIONS,
  buildSpanIndex,
  conflictIdOf,
  openVault,
  readCassette,
  readRepoAssets,
  replayModel,
  requestDigest,
  writeCassette,
  inspectProjection,
  readProjectionManifest,
  type Cassette,
  type CassetteRecord,
} from "@forge/store";
import { AGENTS_MD_MAX_RULES } from "../../../scripts/gates/lib/policy.mjs";
import { parseAgentRules } from "../../../scripts/gates/lib/harness.mjs";
import { completeOnce } from "./model-http.ts";
import { DEFAULT_PORT, startServer } from "./serve.ts";

/**
 * 三种决议的取值。写成常量是给 CLI 的校验用：
 * 提示里再内联一份拼法，迟早会与 `RESOLUTIONS` 漂移。
 */
const RESOLUTION_VALUES = [RESOLUTIONS.REPLACE, RESOLUTIONS.KEEP, RESOLUTIONS.DEFER] as const;

const USAGE = `forge —— 把痕迹编译成资产

用法：
  forge compile [--vault <目录>] [--import <文件>] [--name <名字>]
      导入（可选）并编译：sources → 事件 IR → 事件资产 → 重建 index。
      幂等：同一份来源跑两次，产出相同的字节。

  forge lint [--vault <目录> | --repo] [--today <YYYY-MM-DD>]
      审核资产（schema / ID 前缀 / 出处 / 必填字段与章节）。有违规时退出码为 1。

  forge emit --out <目录> [--vault <目录>] [--title <标题>] [--check] [--skill] [--evals]
      把资产投影成 AGENTS.md / INDEX.md / adr/。输出逐字节确定。
      --skill：额外导出 Skill（SKILL.md + references/）——决策全文按需读，不预加载。
      --evals：额外导出候选用例集（evals/extraction/cases.json）。
               它**永远自称 proposed**：确认是人做的事（ADR-0020）。
      --check：只比对不写盘（一致时退出码 0，不一致为 1）。

  forge bootstrap
      自举（S29）：审核本仓库自己的资产、数 ADR（目标 ≥ 30）、核对种子规则与
      两把尺子的人工确认，并检查 listing/ 与 demo/ 是否与库逐字节一致。
      没有付费信号时，团队版必须是 deferred（S30）；开了能力却没信号会报红。

  forge listing --out <目录> [--repo | --vault <目录>] [--title <标题>] [--check]
      上架包（S31）：资产 → marketplace / plugin / Skill / MCP 配置。
      产物**永远自称 draft、published=false**：上架需要人去提交，代码不替人按按钮。
      --repo  用本仓库自己的资产（自举）；--check 只比对不写盘。

  forge demo --out <目录> [--repo | --vault <目录>] [--title <标题>] [--check]
      对外 demo（S32）：资产 → 一份静态站点（index.html + 每条一页 + library.json）。
      **用你自己的库，不是编造的样例**；没有外部脚本、没有时间戳，可离线打开。
      --repo  用本仓库自己的资产（自举）；--check 只比对不写盘。

  forge extract [--vault <目录>] (--cassette <文件> | --record <文件>)
      **模型只做抽取**：事件 → 候选断言 → 入库守卫 → 候选区 _inbox/。
      --cassette <文件>  对着录像跑（不需要 API key，结果可复现）
      --record <文件>    调一次模型并把响应录下来，然后对着录像跑
      --endpoint <URL>   模型端点（默认取 FORGE_MODEL_ENDPOINT，或官方端点）
      --model <名字>     模型名（--record 时必填）
      全程不写 assets/：抽取的产出**不可能**直接进正式资产。

  forge inbox [--vault <目录>] [--promote <候选 ID> --date <YYYY-MM-DD> --confidence <0..1>]
      列出候选区。--promote 把一条候选**由人确认**成草稿资产（会移出候选区）。

  forge link [--vault <目录>]
      候选区 × 现有资产 → 归并（S18）+ 冲突判定（S19）→ 冲突队列 _conflicts/。
      **不写 assets/**：判定只出候选与证据，改写只能由下一条命令触发。

  forge conflicts [--vault <目录>] [--resolve <冲突 ID> --decision <replace|keep|defer>
                  --date <YYYY-MM-DD> --rationale <为什么> [--confidence <0..1>] [--actor <谁>]]
      列出冲突队列。--resolve 是**唯一**能改写已有状态的动作（ADR-0028）：
        replace  落下一代新状态（supersedes 旧的），旧的那代只改 status
        keep     旧的仍然成立——**一个字节都不动**
        defer    今天不判，留在队列里

  forge context <查询> [--vault <目录>] [--budget <token>] [--today <YYYY-MM-DD>] [--types <类型,…>]
      检索并渲染一段**预算内**的注入上下文（S21）。这是"取用"的那条路。
      **绝不预加载全库**：与查询无关（分数 0）的条目一条都不注入，
      状态不合格（superseded / 过期的 state）的进 excluded，被预算挡住的条数写在注入块自己里面。

  forge health [--vault <目录>] [--today <YYYY-MM-DD>] [--due] [--out <文件>]
      健康检查（S25）：孤儿页 / 索引漂移 / 过期断言 / 静默被取代 / 审计完整性。
      **它只读**——只报，不修。有需要动手的问题时退出码为 1（孤儿不计）。
      --due   只列到期未确认的状态（S26 的定时任务问的就是这一个问题）
      --out   把报告写到文件（定时任务把它当周报正文）

  forge confirm <资产 ID> --date <YYYY-MM-DD> --note <为什么仍然成立> [--vault <目录>] [--actor <谁>]
      重新确认一条 state 仍然成立（S26）。**只动 last_confirmed 一个字段**——
      正文、出处、题面一个字节都不动，理由进审计、不进资产。
      --note 必填：没有理由的确认等于一次点击。

  forge audit [--vault <目录>] [--verify] [--limit <条数>]
              [--actor <谁>] [--kind <种类>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>]
      审计日志（S27）：列出 / 核对哈希链。链断掉时退出码为 1。
      审计记的是**经过 forge 的每一次写入**（谁、什么时候、动了什么）。
      过滤只影响**列出**；--verify 始终核对整条链。没有匹配项时会明说，
      不会把"筛选后为空"渲染成"没有日志"。

  forge weekly [--vault <目录>] [--today <YYYY-MM-DD>] [--days <天数>] [--out <文件>]
      周报（S28）：这一周库变成了什么样（健康）+ 谁动了它（审计）。
      窗口与基准日都是输入，所以同一周的周报可以重印，字节相同。

  forge serve [--vault <目录>] [--port <端口>] [--token <串>] [--today <YYYY-MM-DD>]
              [--selectors <远端配置的 URL>]
      本机回环桥（S23）：浏览器扩展靠它取用与上报采集。
      **只绑 127.0.0.1，而且需要 token**——回环不等于安全，任何一个网页都能发请求。
      --token 不给就生成一个并打在 stderr 上（填进扩展的选项页）。
      --selectors 指到一份远端选择器配置：平台改版时改它，不用重新发扩展。

选项：
  --vault <目录>   资产库位置（默认：./data）
  --repo           对**本仓库**的资产（带 front-matter 的 markdown）做 lint
  --today <日期>   lint / health / weekly 的基准日 / context、serve 的新鲜度基准日
                   （默认：不检查新鲜度）
  --actor <谁>     审计里的行为人（promote / conflicts --resolve / confirm）；
                   forge audit 时表示按行为人过滤
  --kind <种类>    forge audit 的过滤：source-imported / candidates-recorded /
                   asset-promoted / conflict-resolved / state-confirmed
  --since <日期>   forge audit 的起始日（含）
  --until <日期>   forge audit 的截止日（含）
`;

interface ParsedArgs {
  command: string;
  vault: string;
  repo: boolean;
  importPath: string | null;
  name: string | null;
  out: string | null;
  title: string | null;
  check: boolean;
  today: string | null;
  cassette: string | null;
  record: string | null;
  endpoint: string | null;
  model: string | null;
  promote: string | null;
  date: string | null;
  confidence: string | null;
  resolve: string | null;
  decision: string | null;
  rationale: string | null;
  actor: string | null;
  query: string | null;
  budget: string | null;
  types: string | null;
  skill: boolean;
  evals: boolean;
  port: string | null;
  token: string | null;
  selectors: string | null;
  due: boolean;
  verify: boolean;
  limit: string | null;
  note: string | null;
  days: string | null;
  kind: string | null;
  since: string | null;
  until: string | null;
}

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: "",
    vault: "data",
    repo: false,
    importPath: null,
    name: null,
    out: null,
    title: null,
    check: false,
    today: null,
    cassette: null,
    record: null,
    endpoint: null,
    model: null,
    promote: null,
    date: null,
    confidence: null,
    resolve: null,
    decision: null,
    rationale: null,
    actor: null,
    query: null,
    budget: null,
    types: null,
    skill: false,
    evals: false,
    port: null,
    token: null,
    selectors: null,
    due: false,
    verify: false,
    limit: null,
    note: null,
    days: null,
    kind: null,
    since: null,
    until: null,
  };

  const rest = [...argv];
  args.command = rest.shift() ?? "";

  while (rest.length > 0) {
    const flag = rest.shift() ?? "";
    // 位置参数：`context` 的查询是一句话，它不该被逼成一个 `--query` 选项
    // （那样每次都要给引号，而且 `forge context --query` 这种写法在 shell 里更容易写错）。
    // 只有第一个位置参数被收下，第二个直接报错——猜"哪个是查询"不如不猜。
    if (!flag.startsWith("-")) {
      if (args.query !== null) throw new UsageError(`多余的位置参数：${flag}`);
      args.query = flag;
      continue;
    }
    const value = (): string => {
      const next = rest.shift();
      if (next === undefined) throw new UsageError(`选项 ${flag} 缺少值`);
      return next;
    };
    switch (flag) {
      case "--vault":
        args.vault = value();
        break;
      case "--repo":
        args.repo = true;
        break;
      case "--import":
        args.importPath = value();
        break;
      case "--name":
        args.name = value();
        break;
      case "--out":
        args.out = value();
        break;
      case "--title":
        args.title = value();
        break;
      case "--today":
        args.today = value();
        break;
      case "--check":
        args.check = true;
        break;
      case "--cassette":
        args.cassette = value();
        break;
      case "--record":
        args.record = value();
        break;
      case "--endpoint":
        args.endpoint = value();
        break;
      case "--model":
        args.model = value();
        break;
      case "--promote":
        args.promote = value();
        break;
      case "--date":
        args.date = value();
        break;
      case "--confidence":
        args.confidence = value();
        break;
      case "--resolve":
        args.resolve = value();
        break;
      case "--decision":
        args.decision = value();
        break;
      case "--rationale":
        args.rationale = value();
        break;
      case "--actor":
        args.actor = value();
        break;
      case "--budget":
        args.budget = value();
        break;
      case "--types":
        args.types = value();
        break;
      case "--skill":
        args.skill = true;
        break;
      case "--evals":
        args.evals = true;
        break;
      case "--port":
        args.port = value();
        break;
      case "--token":
        args.token = value();
        break;
      case "--selectors":
        args.selectors = value();
        break;
      case "--due":
        args.due = true;
        break;
      case "--verify":
        args.verify = true;
        break;
      case "--limit":
        args.limit = value();
        break;
      case "--note":
        args.note = value();
        break;
      case "--days":
        args.days = value();
        break;
      case "--kind":
        args.kind = value();
        break;
      case "--since":
        args.since = value();
        break;
      case "--until":
        args.until = value();
        break;
      default:
        throw new UsageError(`未知选项：${flag}`);
    }
  }

  return args;
}

class UsageError extends Error {}

/**
 * @param {string} line
 * @returns {void}
 */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * @param {string} line
 * @returns {void}
 */
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * @returns {Promise<number>}
 */
async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    err(USAGE);
    return 2;
  }

  if (args.command === "" || args.command === "--help" || args.command === "-h") {
    out(USAGE);
    return 0;
  }

  switch (args.command) {
    case "compile":
      return runCompile(args);
    case "lint":
      return runLint(args);
    case "emit":
      return runEmit(args);
    case "bootstrap":
      return runBootstrap();
    case "listing":
      return runListing(args);
    case "demo":
      return runDemo(args);
    case "extract":
      return await runExtract(args);
    case "inbox":
      return runInbox(args);
    case "link":
      return runLink(args);
    case "conflicts":
      return runConflicts(args);
    case "context":
      return runContext(args);
    case "health":
      return runHealthCommand(args);
    case "confirm":
      return runConfirm(args);
    case "audit":
      return runAudit(args);
    case "weekly":
      return runWeekly(args);
    case "serve":
      return await runServe(args);
    default:
      err(`✗ 未知命令：${args.command}`);
      err(USAGE);
      return 2;
  }
}

/**
 * `forge extract` —— 模型只做抽取，其余全是确定性的（S15 / S16）。
 *
 * 五步，顺序不能换：derive → 建请求 → 取响应（录像或录制）→ 抽取+守卫 → 只写候选区。
 *
 * 之所以先全部算完再写盘：一次抽取要么完整落进候选区，要么什么都不落。
 * 半套的候选区比空候选区更难查——它会让人以为模型只抽出了一半。
 *
 * **为什么只有这一条命令是异步的**：`--record` 要调网络，而网络是异步的。
 * 抽取链路本身是纯的（ADR-0021）——异步只出现在"把响应取回来"这一步，
 * 它不渗进任何判定。
 *
 * @param {ParsedArgs} args
 * @returns {Promise<number>}
 */
async function runExtract(args: ParsedArgs): Promise<number> {
  if (args.cassette === null && args.record === null) {
    err(
      "✗ extract 必须给 --cassette <文件> 或 --record <文件>。\n" +
        "  抽取需要一个模型，而模型只有两种来法：对着已经录好的响应跑（可复现、不要 key），\n" +
        "  或者当场录一段（要 key）。**不给默认值**：悄悄用某个模型跑一遍，" +
        "得到的结果既不可复现、也说不清是谁抽的。",
    );
    return 2;
  }
  if (args.cassette !== null && args.record !== null) {
    err("✗ --cassette 与 --record 只能给一个：一个是回放、一个是录制，含义相反。");
    return 2;
  }

  const vault = openVault(resolve(args.vault));
  // 先取输入（这一步不碰模型），再决定用哪种模型——录制的"要问哪些问题"就来自它。
  const planned = vault.inputs();
  if (planned.length === 0) {
    err("✗ 库里没有事件：先 forge compile --import <导出文件>。");
    return 1;
  }

  let model: Model;
  try {
    model =
      args.record !== null
        ? await recordingModel(args, planned.map((input) => buildExtractionRequest(input)))
        : replayModel(readCassette(resolve(args.cassette ?? "")));
  } catch (error) {
    err(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const run = vault.extract({ model });

  if (run.failures.length > 0) {
    err(`✗ 有 ${run.failures.length} 个来源抽取失败，**本次不落盘**：`);
    for (const failure of run.failures) err(`  - ${failure.sourceId}：${failure.reason}`);
    return 1;
  }

  // 不变量：这条路径的候选来源恒为 `model`，而守卫**永远**不会把模型产出判成可入库。
  // 这里判成非空 = 守卫被改松了，属于缺陷，不是配置问题。
  const leaks = modelLeaks(run.guard);
  if (leaks.length > 0) {
    err(`✗ 入库守卫把 ${leaks.length} 条模型产出判成了「可直接入库」——守卫被改松了：`);
    for (const leak of leaks) err(`  - ${leak}`);
    return 1;
  }

  const written = vault.recordCandidates(run, { atMs: Date.now(), actor: args.actor });

  const candidates = run.units.flatMap((unit) => unit.result.candidates);
  const discarded = run.units.flatMap((unit) => unit.result.discarded);
  const notes = run.units.flatMap((unit) => unit.result.notes);

  out(
    `✓ 抽取完成：事件 ${String(run.eventCount)} 条 → 候选 ${String(candidates.length)} 条` +
      `（harness=${EXTRACTION_HARNESS}，model=${model.id}）`,
  );
  out(
    `  守卫：候选区 ${String(run.guard.inboxed.length)} · 直接入库 ${String(run.guard.admitted.length)}` +
      ` · 丢弃 ${String(run.guard.rejected.length)}`,
  );
  out(`  候选区落盘 ${String(written.written.length)} 条`);
  if (written.duplicates > 0) {
    out(`  本次跑里内容重复、只算一条的：${String(written.duplicates)} 条（候选 ID 是内容寻址的）`);
  }
  if (written.skippedExisting.length > 0) {
    out(
      `  跳过 ${String(written.skippedExisting.length)} 条：已经有一条资产指着同一处出处了` +
        "（重复确认不会产生第二条资产，只会让同一处证据有两份记录）",
    );
  }
  out("· 模型产出**不进 assets/**：候选都躺在 _inbox/，等 `forge inbox --promote` 由人确认");

  if (discarded.length > 0) {
    out(`⚠ 丢弃 ${String(discarded.length)} 条（模型编造的内容 / 读不成的形状）：`);
    for (const item of discarded.slice(0, 20)) out(`  - [${item.code}] ${item.at}：${item.message}`);
    if (discarded.length > 20) out(`  …（共 ${String(discarded.length)} 条）`);
  }
  if (notes.length > 0) {
    out(`· 代码处理掉的 ${String(notes.length)} 处（不需要你动手，但必须被看见）：`);
    for (const note of notes.slice(0, 20)) out(`  - [${note.code}] ${note.at}：${note.message}`);
    if (notes.length > 20) out(`  …（共 ${String(notes.length)} 条）`);
  }
  if (run.guard.rejected.length > 0) {
    out(`⚠ 守卫拒绝 ${String(run.guard.rejected.length)} 条：`);
    for (const decision of run.guard.rejected) {
      for (const violation of decision.violations) {
        out(`  [${violation.code}] ${decision.candidate.title}：${violation.message}`);
      }
    }
  }

  return 0;
}

/**
 * 录一段模型响应，写成 cassette，再回放它。
 *
 * 为什么录完立刻回放、而不是直接把响应拿去用：**同一段代码只走一条路**。
 * 如果录制路径直接把响应喂给抽取、而回放路径走另一条，两条路迟早会分叉——
 * 于是"录像里跑出来的结果"与"当时看到的结果"不是同一个东西，
 * 而那正是"评测可比"这件事的地基。
 *
 * @param {ParsedArgs} args
 * @param {import("@forge/core").ModelRequest[]} requests
 * @returns {Promise<Model>}
 */
async function recordingModel(args: ParsedArgs, requests: import("@forge/core").ModelRequest[]): Promise<Model> {
  const apiKey = process.env["FORGE_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? "";
  if (apiKey.length === 0) {
    throw new Error(
      "--record 需要 API key：设 FORGE_API_KEY（或 OPENAI_API_KEY）。" +
        "没有 key 也能跑抽取——用 --cassette 对着已经录好的响应跑。",
    );
  }
  const modelName = args.model;
  if (modelName === null) {
    throw new Error("--record 必须给 --model <名字>：报告要能回答「这条是谁抽的」。");
  }
  const endpoint = args.endpoint ?? process.env["FORGE_MODEL_ENDPOINT"] ?? "https://api.openai.com/v1";
  const path = resolve(args.record ?? "");

  const records: CassetteRecord[] = [];
  for (const [index, request] of requests.entries()) {
    out(`· 录制 ${String(index + 1)}/${String(requests.length)} …`);
    const response = await completeOnce({ endpoint, model: modelName, apiKey }, request);
    records.push({ request_digest: requestDigest(request), response });
  }

  const cassette: Cassette = {
    cassette_version: CASSETTE_VERSION,
    // 没有时间戳：录像也是产出，两次录制同样的响应必须得到同样的字节（R6）。
    about: `由 forge extract --record 录制（harness=${EXTRACTION_HARNESS}，${String(requests.length)} 段请求）`,
    model: modelName,
    harness: EXTRACTION_HARNESS,
    records,
  };
  writeCassette(path, cassette);
  out(`✓ 已录制 ${String(records.length)} 段响应 → ${path}`);
  return replayModel(cassette);
}

/**
 * `forge inbox` —— 候选区的**读**路径（S16 的另一半）。
 *
 * 只有写没有读的候选区就是 implement2.md 说的"只写不读"：
 * 模型每天往里塞东西，没有人看，于是它变成一个越来越大的、没人敢删的目录。
 * 所以列出与确认这两件事必须在 Phase 4 就存在，而不是等 Phase 5 的队列。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runInbox(args: ParsedArgs): number {
  const vault = openVault(resolve(args.vault));

  if (args.promote !== null) {
    if (args.date === null) {
      err("✗ --promote 必须给 --date <YYYY-MM-DD>：值得记的是人确认它的那天，不是命令跑的那天。");
      return 2;
    }
    if (args.confidence === null) {
      err(
        "✗ --promote 必须给 --confidence <0..1>：置信度是你对这条断言的判断。\n" +
          "  没有默认值——默认值会让「确认」退化成一次点击，而这是整个产品里最像人的那部分判断。",
      );
      return 2;
    }
    const confidence = Number(args.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      err(`✗ --confidence 要在 0..1 之间，收到「${args.confidence}」`);
      return 2;
    }

    const result = vault.promote(args.promote, {
      date: args.date,
      confidence,
      actor: args.actor,
      atMs: Date.now(),
      // 随机性显式取自系统熵：ID 里"何时写下"的语义由 ULID 承担（ADR-0007），
      // 而这一次写入是人的动作，不是可重算的派生数据。
      random: new Uint8Array(randomBytes(16)),
    });

    if (!result.ok) {
      err(`✗ ${result.reason}`);
      return 1;
    }
    out(`✓ 已确认成草稿资产：${result.asset.path}`);
    out("· 索引层还没跟上：跑一次 `forge compile`（健康检查会把这件事报成 HEALTH_INDEX_DRIFT）");
    out(
      "· 这是一份**草稿**，不是一条已确认的事实：正文原样搬了过来，" +
        "必填章节还没写。跑 `forge lint` 会明确告诉你缺什么——" +
        "在这里补一句「待补」让它变绿，等于把绿灯变成一句谎话。",
    );
    return 0;
  }

  const scan = vault.inbox.scan();
  if (scan.invalid.length > 0) {
    err(`⚠ 有 ${scan.invalid.length} 个候选文件读不动（不是静默跳过）：`);
    for (const item of scan.invalid) err(`  - ${item.path}：${item.reason}`);
  }

  if (scan.records.length === 0) {
    out("· 候选区是空的。`forge extract` 会把模型抽出来的东西放进这里。");
    return scan.invalid.length > 0 ? 1 : 0;
  }

  out(`候选区 ${scan.records.length} 条（都不在 assets/ 里，都还没被任何人确认）：`);
  for (const record of scan.records) {
    out(`  [${record.type}] ${record.title}`);
    out(`      ${record.candidate_id}`);
    out(`      confidence=${String(record.confidence)} · origin=${record.origin} · ${record.sources.join("、")}`);
  }
  return scan.invalid.length > 0 ? 1 : 0;
}

/**
 * `forge link` —— 归并（S18）+ 冲突判定（S19）→ 队列（S20）。
 *
 * **它一个字节都不写 `assets/`。** 这不是实现细节，是这个命令存在的意义：
 * 判定只出候选与证据，改写只能由 `forge conflicts --resolve` 触发——
 * 由人、带日期、带理由。这条边界被 `E9` 每次 CI 问一遍。
 *
 * 它也**不需要模型**：规则（同一处证据 / 同一个题面）能把大部分候选归好位，
 * 拿不准的一律新建。模型的接缝是可选的（`vault.judge({merge, conflict})`），
 * 将来从 CLI 传进来——Phase 6 与检索一起做。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runLink(args: ParsedArgs): number {
  const vault = openVault(resolve(args.vault));
  const run = vault.judge();
  const written = vault.recordConflicts(run);

  const sameEvidence = run.plan.links.filter((link) => link.kind === "same-evidence").length;
  const sameSubject = run.plan.links.filter((link) => link.kind === "same-subject").length;

  out(
    `✓ 归并：候选 ${String(run.candidates.length)} 条 → 链接 ${String(run.plan.links.length)}` +
      `（同证据 ${String(sameEvidence)} · 同题面 ${String(sameSubject)}）` +
      ` · 提议归并 ${String(run.plan.proposals.length)} · 新建 ${String(run.plan.fresh.length)}`,
  );
  if (run.plan.proposals.length > 0) {
    out("  · 提议的归并**没有自动成立**：它进队列等人看一眼（ADR-0026：不确定就新建，别乱并）");
  }

  const byRule = run.judgement.conflicts.filter((conflict) => conflict.basis === "subject-rule").length;
  const byModel = run.judgement.conflicts.length - byRule;
  out(
    `✓ 冲突：${String(run.judgement.conflicts.length)} 条进队列` +
      `（规则 ${String(byRule)} · 模型提议 ${String(byModel)}）` +
      ` · 再确认 ${String(run.judgement.refreshes.length)} 条 · 丢弃 ${String(run.judgement.dropped.length)} 条`,
  );
  out(
    `  队列落盘 ${String(written.written.length)} 条` +
      (written.existing.length === 0
        ? ""
        : `；已有 ${String(written.existing.length)} 条（同一个 ID）——它们已经被人看过或判过了，不重复写`),
  );
  out("· 冲突**永不自动应用**：改写已有状态只能由 `forge conflicts --resolve` 触发（ADR-0027/0028）");

  for (const conflict of run.judgement.conflicts) {
    out(`  [${conflict.basis}] ${conflict.linkKey}`);
    out(`      ${conflict.why}`);
    out(`      冲突 ID：${conflictIdOf(conflict)}`);
    for (const span of conflict.evidence) out(`      证据：${span}`);
  }

  for (const refresh of run.judgement.refreshes) {
    out(`  · 再确认（不是冲突）：${refresh.asset.path} —— ${refresh.why}`);
  }

  // 丢掉的那些**必须打出来**：它们属于"看起来很安静但其实漏了"的那一类，
  // 而"state 缺题面"是最危险的一种——那条状态从此不参与冲突判定。
  if (run.judgement.dropped.length > 0) {
    out(`⚠ 丢弃 ${String(run.judgement.dropped.length)} 条（**这一批没有参与判定**）：`);
    for (const item of run.judgement.dropped) out(`  - ${item.at}：${item.reason}`);
  }
  for (const note of run.judgement.notes) out(`  ⚠ ${note}`);

  // 题面塌陷的可见性（ADR-0025 的残余风险）：一个总给同一个题面的抽取器
  // 会让整个库变成一个实体，于是每次确认都变成一次冲突。
  if (run.crowdedSubjects.length > 0) {
    out("· 题面最集中的几条（**塌陷是这么开始的**，看一眼是不是抽坏了）：");
    for (const item of run.crowdedSubjects) out(`  - ${item.subject}：${String(item.count)} 条候选`);
  }

  return 0;
}

/**
 * `forge conflicts` —— 队列的**读**路径与**唯一**的写路径（S20）。
 *
 * 列队列不改库；判"采纳哪一侧"才改库——而后者必须由人显式给三样东西：
 * 决议、日期、理由。缺一样就报错退出：**没有默认值**。
 * 默认值会让"确认"退化成一次点击，而这是这个产品里最像人的那部分判断。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runConflicts(args: ParsedArgs): number {
  const vault = openVault(resolve(args.vault));

  if (args.resolve !== null) {
    return resolveConflict(vault, args, args.resolve);
  }

  const scan = vault.conflicts.scan();
  if (scan.invalid.length > 0) {
    err(`⚠ 有 ${String(scan.invalid.length)} 个队列文件读不动（不是静默跳过）：`);
    for (const item of scan.invalid) err(`  - ${item.path}：${item.reason}`);
  }

  if (scan.records.length === 0) {
    out("· 冲突队列是空的。`forge link` 会把判定出来的矛盾放进这里等人判。");
    return scan.invalid.length > 0 ? 1 : 0;
  }

  const countOf = (status: string): number => scan.records.filter((record) => record.status === status).length;
  out(
    `冲突队列 ${String(scan.records.length)} 条` +
      `（待判 ${String(countOf(CONFLICT_STATUS.OPEN))} · 已推迟 ${String(countOf(CONFLICT_STATUS.DEFERRED))}` +
      ` · 已判 ${String(countOf(CONFLICT_STATUS.RESOLVED))}）：`,
  );

  for (const record of scan.records) {
    out(`  [${record.status}] ${record.conflict_id} · ${record.link_key} · basis=${record.basis}`);
    if (record.status === CONFLICT_STATUS.RESOLVED && record.resolution !== null) {
      const applied = record.resolution.applied;
      out(`      ${record.resolution.date} 判决 ${record.resolution.decision}：${record.resolution.rationale}`);
      out(`      ${applied === null ? "没有写任何资产" : `落下 ${applied.asset_id}，取代 ${applied.supersedes}`}`);
      continue;
    }
    out(`      ${record.why}`);
    out(`      现状：${record.incumbent.path}（${record.incumbent.status}）`);
    out(
      `      新证据：${record.incoming.label}` +
        `（origin=${record.incoming.origin}，候选 ${record.incoming.candidate_id}）`,
    );
    out("      证据（两侧都要能点开，否则这条记录没法核对）：");
    for (const span of record.evidence) out(`        - ${span}`);
  }

  out("");
  out("· 判一条：forge conflicts --resolve <ID> --decision <replace|keep|defer> --date <日期> --rationale <为什么>");
  out("  replace 还要给 --confidence：换成新的、留着旧的、还是今天不判，动的东西完全不同。");
  return scan.invalid.length > 0 ? 1 : 0;
}

/**
 * 判一条冲突。**这是全项目唯一一处能改写已有状态的地方**（ADR-0028）。
 *
 * 参数校验写在这里而不是"给个默认值"：`--decision` / `--date` / `--rationale`
 * 三样缺一样都不许往下走——它们全是人的判断，而任何默认值都会让"确认"
 * 退化成一次点击。
 *
 * @param {import("@forge/store").Vault} vault
 * @param {ParsedArgs} args
 * @param {string} conflictId 要判的那条（由调用方收窄过——`--resolve` 给了才走到这儿）
 * @returns {number}
 */
function resolveConflict(vault: import("@forge/store").Vault, args: ParsedArgs, conflictId: string): number {
  if (args.decision === null) {
    err("✗ --resolve 必须给 --decision <replace|keep|defer>：换成新的、留着旧的、还是今天不判，动的东西完全不同。");
    return 2;
  }
  if (!(RESOLUTION_VALUES as readonly string[]).includes(args.decision)) {
    err(`✗ --decision 只能是 ${RESOLUTION_VALUES.join(" / ")}，收到「${args.decision}」`);
    return 2;
  }
  if (args.date === null) {
    err("✗ --resolve 必须给 --date <YYYY-MM-DD>：值得记的是你判它的那天，不是命令跑的那天。");
    return 2;
  }
  if (args.rationale === null) {
    err(
      "✗ --resolve 必须给 --rationale <为什么>：没有理由的判定等于一次点击。\n" +
        "  这条记录是留给下一个读它的人的——他要知道当时凭什么信了这一侧。",
    );
    return 2;
  }

  let confidence: number | undefined;
  if (args.decision === RESOLUTIONS.REPLACE) {
    if (args.confidence === null) {
      err("✗ --decision replace 必须给 --confidence <0..1>：它是你对新那条状态的判断，没有默认值。");
      return 2;
    }
    confidence = Number(args.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      err(`✗ --confidence 要在 0..1 之间，收到「${args.confidence}」`);
      return 2;
    }
  }

  const result = vault.resolveConflict(conflictId, {
    decision: args.decision as (typeof RESOLUTION_VALUES)[number],
    date: args.date,
    rationale: args.rationale,
    actor: args.actor,
    ...(confidence === undefined ? {} : { confidence }),
    atMs: Date.now(),
    random: new Uint8Array(randomBytes(16)),
  });

  if (!result.ok) {
    err(`✗ ${result.reason}`);
    return 1;
  }

  out(`✓ 已判（${result.record.resolution?.decision ?? "?"}）：${result.record.conflict_id}`);
  if (result.applied === null) {
    out("  · 没有写任何资产：这条决议只是把队列里的那条记录标掉了。");
  } else {
    out(`  · 落下 ${result.applied.asset_id}（${result.applied.path}），取代 ${result.applied.supersedes}`);
    out("  · 被取代的那一代**只改了 status**：正文与出处一个字节都没动，它仍然可读、可核对。");
    out("  · 跑 `forge lint` 会报新那条缺必填章节——那是提醒你把状态写成一句话，不是让你补一句「待补」。");
    out("  · 索引层还没跟上：跑一次 `forge compile`（健康检查会把这件事报成 HEALTH_INDEX_DRIFT）。");
  }
  out("  · 记录留在队列里：它是「谁在什么时候凭什么换了这条状态」的唯一答案。");
  return 0;
}

/**
 * `forge context` —— 取用：把"为了做完这件事最少需要知道的东西"渲染出来（S21）。
 *
 * 这个命令存在的意义是 implement2.md 给 P6 写的那条北极星：
 * **被"调用"，而不是被"打开"**。所以它的输出是**一段可以直接进上下文的文字**，
 * 而不是一份报告——报告要人读，注入块要被贴进去。
 *
 * 三件事写在这里而不是 core 里：参数校验、把库读进内存、把自证结果翻译成退出码。
 * 判定（打分、预算、排除）全在 `@forge/core` 的 `retrieve`，
 * 于是 MCP server 与浏览器扩展里的那两个宿主用的是**同一份**判定。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runContext(args: ParsedArgs): number {
  if (args.query === null) {
    err("✗ context 需要一句查询：forge context \"存储后端怎么选\"");
    return 2;
  }

  const budget = args.budget === null ? DEFAULT_BUDGET_TOKENS : Number(args.budget);
  if (!Number.isSafeInteger(budget) || budget < MIN_BUDGET_TOKENS) {
    err(
      `✗ --budget 要是不小于 ${String(MIN_BUDGET_TOKENS)} 的整数（收到「${args.budget ?? ""}」）。\n` +
        "  低于这个数，注入块里那句「这不是全库、挡住了几条」自己就装不下——" +
        "而那句话正是这个命令区别于「把库全塞进去」的地方。",
    );
    return 2;
  }

  let types: AssetType[] | undefined;
  if (args.types !== null) {
    const wanted = args.types
      .split(",")
      .map((piece) => piece.trim())
      .filter((piece) => piece.length > 0);
    const unknown = wanted.filter((piece) => !isAssetType(piece));
    if (unknown.length > 0) {
      err(`✗ --types 里有不认识的类型：${unknown.join("、")}（只有 ${ASSET_TYPES.join(" / ")}）`);
      return 2;
    }
    types = wanted.filter(isAssetType);
  }

  const vault = openVault(resolve(args.vault));
  // 判定与渲染都在 `vault.context` 里（也就是 `@forge/core` 的纯函数）：
  // MCP server 与 `forge serve` 走的是同一个入口，所以三个宿主给出的注入**逐字节相同**。
  const run = vault.context({
    query: args.query,
    budget,
    today: args.today,
    ...(types === undefined ? {} : { types }),
  });

  if (run.invalid.length > 0) {
    // 读不动的资产会让检索**静默地**少一截——而"少一截"与"库里没有"看起来一样。
    err(`⚠ 有 ${String(run.invalid.length)} 个文件读不成资产，它们**没有参与检索**：`);
    for (const item of run.invalid) err(`  - ${item.path}：${item.reason}`);
  }

  // 自证：注入块有没有违反它自己的承诺（超预算 / 零分项 / 无出处）。
  // 它**每次**都跑，不是只在测试里跑——这一段代码在别的宿主里也走同一条路。
  if (run.violations.length > 0) {
    err(`✗ 注入块违反了它自己的承诺（${String(run.violations.length)} 处）：`);
    for (const violation of run.violations) err(`  - ${violation}`);
    return 1;
  }

  process.stdout.write(run.rendered);

  // 计数走 stderr：stdout 要能被原样重定向进上下文，混进一行统计就毁了这个用途。
  const result = run.result;
  err(
    `· 参与打分 ${String(result.considered)} 条 · 注入 ${String(result.items.length)} 条` +
      `（无关 ${String(result.irrelevant)} · 预算放不下 ${String(result.dropped.length)}` +
      ` · 状态/新鲜度不合格 ${String(result.excluded.length)}）· ${String(result.usedTokens + result.metaTokens)}/${String(result.budget)} token`,
  );
  return run.invalid.length > 0 ? 1 : 0;
}

/**
 * `forge health` —— 健康检查（S25）+ 定时任务的问句（S26）。
 *
 * 退出码是**给 cron 用的**：0 = 没有需要动手的事，1 = 有。
 * cron 只在你需要动手的那一周才来敲门——这是"定时任务"与"每周一份没人看的邮件"
 * 的区别。孤儿（info）**不进退出码**：一条长期挂着的红等于没有红。
 *
 * `--due` 是同一个判定的一小半：它只问"今天该找谁确认"。写成一个开关而不是
 * 另一个命令，是因为**它必须与健康报告用的是同一份判据**（`freshnessBacklog`）——
 * 两份实现漂移的方向永远是"定时任务报的与报告里的不一样"。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runHealthCommand(args: ParsedArgs): number {
  const today = args.today;
  if (today === null) {
    err(
      "✗ health 必须给 --today <YYYY-MM-DD>：新鲜度的判据依赖「今天是几号」，\n" +
        "  而判定里没有时钟（core 是纯函数）。不给它，报告里就会出现一个\n" +
        "  「跑的那一刻」——那种报告每天都不一样，没法快照、没法 diff。",
    );
    return 2;
  }

  const vault = openVault(resolve(args.vault));
  const run = vault.health({ today });

  if (run.invalid.length > 0) {
    err(`⚠ 有 ${String(run.invalid.length)} 个文件读不成资产，它们**没有参与健康检查**：`);
    for (const item of run.invalid) err(`  - ${item.path}：${item.reason}`);
  }

  if (args.due) {
    if (run.report.due.length === 0) {
      out(`✓ 没有到期的 state（基准日 ${today}）。`);
      return run.invalid.length > 0 ? 1 : 0;
    }
    out(`${String(run.report.due.length)} 条 state 超过了确认窗口，最旧的先看：`);
    for (const item of run.report.due) {
      out(`  ${item.path} —— 已 ${String(item.ageDays)} 天没确认（窗口 ${String(item.windowDays)} 天）`);
    }
    out("");
    out("确认它：forge confirm <资产 ID> --date <日期> --note <为什么它仍然成立>");
    out("· **定时任务只能问，不能自己答**：机器自动刷新会让「过期」永远不被看见（ADR-0036）");
    // **有到期的事就非零**：定时任务靠这个退出码决定要不要来敲门。
    // 永远返回 0 的定时任务不是"安静"，是"没接上"——它把那句最有价值的提醒吞掉了。
    return 1;
  }

  if (args.out !== null) {
    const path = resolve(args.out);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, run.rendered, "utf8");
    err(`✓ 健康报告已写入 ${path}`);
  } else {
    process.stdout.write(run.rendered);
    if (!run.rendered.endsWith("\n")) process.stdout.write("\n");
  }

  err(
    `· 资产 ${String(run.report.total)} 条 · 需要处理 ${String(run.report.actionable.length)} 处` +
      `（error ${String(run.report.actionable.filter((finding) => finding.severity === "error").length)}）` +
      ` · 仅供参考 ${String(run.report.informational.length)} 处 · 到期未确认 ${String(run.report.due.length)} 条`,
  );
  if (run.report.unchecked.length > 0) {
    err(`· 本次没查：${run.report.unchecked.join("；")}`);
  }

  if (run.report.actionable.length > 0 || run.invalid.length > 0) return 1;
  return 0;
}

/**
 * `forge confirm` —— 人重新确认一条 state 仍然成立（S26）。
 *
 * 这个命令存在的**唯一理由**是：定时任务只能问，不能自己回答。
 * 一个会自己刷新 `last_confirmed` 的定时任务会让库永远看起来新鲜，
 * 而"过期"这件事就再也不会被任何人看见——那是维护机器最坏的失败方式：
 * 它把唯一有价值的信号自己抹掉了。
 *
 * 改的字段只有一个，而且这一点由 `unchangedExceptLastConfirmed` 自证
 * （写别的东西就拒绝落盘）。理由进审计、**不进资产**：资产里躺着一段
 * "为什么我认为它成立"的自由文本，会让下一次读它的人分不清
 * 哪句是事实、哪句是当时的辩解。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runConfirm(args: ParsedArgs): number {
  if (args.query === null) {
    err("✗ confirm 需要资产 ID：forge confirm <state_…> --date <YYYY-MM-DD> --note <为什么仍然成立>");
    return 2;
  }
  if (args.date === null) {
    err("✗ --date 必填：值得记的是你重新确认它的那天，不是命令跑的那天。");
    return 2;
  }
  if (args.note === null) {
    err(
      "✗ --note 必填：没有理由的确认等于一次点击。\n" +
        "  它留给下一个读这条状态的人——他要知道你当时凭什么认为它仍然成立。\n" +
        "  （note 进审计，**不进资产**：这条状态的正文与出处一个字节都不会动。）",
    );
    return 2;
  }

  const vault = openVault(resolve(args.vault));
  const result = vault.confirm(args.query, {
    date: args.date,
    note: args.note,
    actor: args.actor,
    atMs: Date.now(),
  });

  if (!result.ok) {
    err(`✗ ${result.reason}`);
    return 1;
  }

  out(`✓ 已确认 ${result.path}：last_confirmed ${result.previous ?? "(从未确认)"} → ${args.date}`);
  out("· 只动了这一个字段：正文、出处、题面一个字节都没有变（自证函数签了字）");
  out("· 索引层还没跟上：跑一次 `forge compile`（健康检查会把这件事报成 HEALTH_INDEX_DRIFT）");
  out(`· 审计 seq ${String(result.audit.seq)} 记下了这次确认与理由——它不改资产，所以理由不进正文`);
  return 0;
}

/**
 * `forge audit` —— 审计日志的读路径（S27）。
 *
 * 与 `forge inbox` / `forge conflicts` 同一条纪律：**只有写没有读的日志等于没有日志**。
 * 一个只追加、从没人看过的文件，在出事那天不会帮上任何忙——因为它没有被读过，
 * 也就没有被信任过。
 *
 * `--verify` 的退出码是给 CI / cron 用的：链断了就非零。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runAudit(args: ParsedArgs): number {
  const vault = openVault(resolve(args.vault));
  const { entries, problems } = vault.audit.read();
  const chain = vault.audit.verify();

  const filtering = args.actor !== null || args.kind !== null || args.since !== null || args.until !== null;

  if (args.verify) {
    if (filtering) {
      err("· 过滤选项对 --verify 无效：链核对的是**整份日志**，不是筛选后的那一段。");
    }
    if (chain.ok) {
      out(`✓ 审计链完整：${String(chain.entries)} 条，从 seq 1 连续到 seq ${String(chain.entries)}，逐条哈希对得上`);
      out(`  ${vault.audit.path()}`);
      return 0;
    }
    err(`✗ 审计链断了（${String(chain.problems.length)} 处）：`);
    for (const problem of chain.problems) err(`  - ${problem}`);
    err("");
    err("  链条断掉之后，**这份日志里的每一条都不能再被相信**——包括那些看起来没问题的。");
    err("  修法是恢复备份或把「这一段不可追溯」写下来，**不是**手工调 seq 或重算 hash。");
    return 1;
  }

  if (problems.length > 0) {
    err(`⚠ 有 ${String(problems.length)} 行读不动（不是静默跳过）：`);
    for (const problem of problems) err(`  - ${problem}`);
  }

  if (entries.length === 0) {
    out("· 审计日志是空的。经过 forge 的写入（promote / resolve / confirm / 采集）会往这里记。");
    out(`  路径：${vault.audit.path()}`);
    return problems.length > 0 ? 1 : 0;
  }

  // 过滤是**读路径**的一部分：日志长了之后，“谁在什么时候动了什么”必须能收窄。
  // 但“筛选后为空”与“日志为空”是两件事——前者会明说，后者在上面就已经返回了。
  const kindValues = new Set<string>(Object.values(AUDIT_KINDS));
  if (args.kind !== null && !kindValues.has(args.kind)) {
    err(
      `✗ --kind 不认识的审计种类「${args.kind}」；可选：${[...kindValues].join(" / ")}`,
    );
    return 2;
  }
  const isDay = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (args.since !== null && !isDay(args.since)) {
    err(`✗ --since 要写成 YYYY-MM-DD，收到「${args.since}」`);
    return 2;
  }
  if (args.until !== null && !isDay(args.until)) {
    err(`✗ --until 要写成 YYYY-MM-DD，收到「${args.until}」`);
    return 2;
  }
  if (args.since !== null && args.until !== null && args.since > args.until) {
    err(`✗ --since（${args.since}）不能晚于 --until（${args.until}）`);
    return 2;
  }

  const filtered = entries.filter(
    (entry) =>
      (args.actor === null || entry.actor === args.actor) &&
      (args.kind === null || entry.kind === args.kind) &&
      (args.since === null || entry.at.slice(0, 10) >= args.since) &&
      (args.until === null || entry.at.slice(0, 10) <= args.until),
  );

  const limit = args.limit === null ? 20 : Number(args.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    err(`✗ --limit 要是正整数，收到「${args.limit ?? ""}」`);
    return 2;
  }

  const shown = filtered.slice(-limit);
  const filters = [
    args.actor === null ? null : `actor=${args.actor}`,
    args.kind === null ? null : `kind=${args.kind}`,
    args.since === null ? null : `since=${args.since}`,
    args.until === null ? null : `until=${args.until}`,
  ].filter((item): item is string => item !== null);
  out(
    `审计日志 ${String(entries.length)} 条（${filters.length === 0 ? "未筛选" : `筛选后 ${String(filtered.length)} 条：${filters.join(" · ")}`}；` +
      `链${chain.ok ? "完整" : "**断了**"}），最近 ${String(shown.length)} 条：`,
  );
  if (shown.length === 0) {
    out("· 没有符合筛选条件的记录——**这不等于日志是空的**（上面写着总条数）。");
    return chain.ok && problems.length === 0 ? 0 : 1;
  }
  for (const entry of shown) {
    out(`  seq ${String(entry.seq)} · ${entry.at} · ${entry.actor} · ${entry.kind} · ${entry.subject}`);
    for (const [key, value] of Object.entries(entry.detail).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      out(`      ${key}：${value}`);
    }
  }
  out("");
  out("· 它记的是**经过 forge 的**每一次写入。有人直接往 assets/ 里放文件，审计看不到——");
  out("  那是文件系统的性质，所以 `forge health` 会把这种沉默的写入报成 AUDIT_UNATTRIBUTED_ASSET。");
  return chain.ok && problems.length === 0 ? 0 : 1;
}

/**
 * `forge weekly` —— 周报（S28）。
 *
 * 它是维护机器**唯一一件给人看的东西**，所以它必须回答两个问题：
 * "这一周库变成了什么样"（健康）与"谁动了它"（审计）。
 * 一条命令、一段 markdown——可以直接进邮件，也可以重定向进一个文件。
 *
 * 没有审计日志时它**不会**说"这一周很安静"：那两句话不一样，
 * 而后者的代价是一个人以为自己的库被照顾着。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runWeekly(args: ParsedArgs): number {
  if (args.today === null) {
    err("✗ weekly 必须给 --today <YYYY-MM-DD>：窗口的末日是一次输入，不是「跑的那一刻」。");
    return 2;
  }
  const days = args.days === null ? 7 : Number(args.days);
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) {
    err(`✗ --days 要是 1..366 的整数，收到「${args.days ?? ""}」`);
    return 2;
  }

  const vault = openVault(resolve(args.vault));
  const run = vault.weekly({ today: args.today, days });

  if (run.invalid.length > 0) {
    err(`⚠ 有 ${String(run.invalid.length)} 个文件读不成资产，它们**没有参与周报**：`);
    for (const item of run.invalid) err(`  - ${item.path}：${item.reason}`);
  }

  if (args.out !== null) {
    const path = resolve(args.out);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, run.rendered, "utf8");
    err(`✓ 周报已写入 ${path}（窗口 ${run.window.start} → ${run.window.end}）`);
  } else {
    process.stdout.write(run.rendered);
    if (!run.rendered.endsWith("\n")) process.stdout.write("\n");
  }

  err(
    `· 窗口 ${run.window.start} → ${run.window.end} · 审计条目 ` +
      (run.audit === null ? "**没有日志**（≠ 这一周没动过）" : String(run.audit.length)) +
      ` · 资产 ${String(run.report.total)} 条 · 需要处理 ${String(run.report.actionable.length)} 处`,
  );
  return run.invalid.length > 0 ? 1 : 0;
}

/**
 * `forge serve` —— 本机回环桥（S23）。传输在 `serve.ts`，这个函数只做参数与生命周期。
 *
 * 它**不会自己退出**：它是一个服务。要停就 Ctrl-C。
 * 退出码只在启动失败时有意义（端口被占、token 不合法）。
 *
 * @param {ParsedArgs} args
 * @returns {Promise<number>}
 */
async function runServe(args: ParsedArgs): Promise<number> {
  const port = args.port === null ? DEFAULT_PORT : Number(args.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    err(`✗ --port 要是 1..65535 的整数，收到「${args.port ?? ""}」`);
    return 2;
  }
  if (args.token !== null && args.token.length < 16) {
    // 一个短 token 不如没有 token：它给人一种"我设了密码"的错觉，而它可以被穷举。
    err("✗ --token 至少 16 个字符：短 token 给人一种「我设了密码」的错觉，而它可以被穷举。");
    return 2;
  }

  let running: Awaited<ReturnType<typeof startServer>>;
  try {
    running = await startServer({
      vault: resolve(args.vault),
      port,
      today: args.today,
      ...(args.token === null ? {} : { token: args.token }),
      selectorUrl: args.selectors,
    });
  } catch (error) {
    err(`✗ 起不来：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  out(`✓ forge serve 在 127.0.0.1:${String(running.port)}（只绑回环，不是 0.0.0.0）`);
  out(`  token：${running.token}`);
  out("  · 把上面这串填进扩展的选项页。每次重启都会换一个——它是随进程生成的，不落盘。");
  out("  · 网页来的请求一律 403，即使它拿到了 token（CORS 只放行扩展来源）。");
  out(
    args.selectors === null
      ? "  · 没给 --selectors：热更新这条线关着，扩展用它自带的那份选择器配置。"
      : `  · 远端选择器配置：${args.selectors}（平台改版时改它，不用重新发扩展）`,
  );
  out("  · Ctrl-C 停止。");

  // 停不下来是正常的：这是一个服务。进程靠信号退出。
  await new Promise<void>(() => {});
  return 0;
}

/**
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runCompile(args: ParsedArgs): number {
  const vault = openVault(resolve(args.vault));

  if (args.importPath !== null) {
    const path = resolve(args.importPath);
    if (!existsSync(path)) {
      err(`✗ 找不到导入文件：${path}`);
      return 2;
    }
    // 读成**文本**而不是 buffer：sources 层的 ID 是内容寻址的（ADR-0013），
    // 而内容必须是可比较的文本。二进制来源（PDF/图片）要各自的连接器。
    const text = readFileSync(path, "utf8");
    const imported = vault.importText(text, { originalName: args.name ?? args.importPath });
    out(
      imported.created
        ? `✓ 新来源 ${imported.meta.id}（connector=${imported.meta.connector}，${imported.meta.bytes} 字节）`
        : `· 来源已存在 ${imported.meta.id}（内容寻址命中，未产生第二份）`,
    );
  }

  const report = vault.compile();
  out(
    `✓ 编译完成：来源 ${report.sources.length} 份 → 事件 ${report.events.length} 条（索引层）；资产 ${report.assets.length} 条`,
  );
  out("· 事件是派生数据，住在 index/，不进 assets/（ADR-0016）");
  if (report.invalid.length > 0) {
    out(`⚠ 有 ${report.invalid.length} 个文件读不成资产：`);
    for (const item of report.invalid) out(`  - ${item.path}：${item.reason}`);
  }
  // 丢弃必须说出来：静默丢弃会让"导入了 1000 条"和"导入了 999 条"看起来一样。
  if (report.discarded.length > 0) {
    out(`⚠ 丢弃 ${report.discarded.length} 条记录：`);
    for (const item of report.discarded.slice(0, 20)) out(`  - #${item.index} ${item.key}：${item.reason}`);
    if (report.discarded.length > 20) out(`  …（共 ${report.discarded.length} 条）`);
  }
  return 0;
}

/**
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runLint(args: ParsedArgs): number {
  const root = resolve(args.vault);
  // `--repo` 是"审本仓库的资产"（CI 的自举路径，ADR-0012）：
  // 资产集合 = 仓库里所有带 front-matter 的 markdown，出处对着仓库根解析。
  //
  // 它**不碰 vault**：lint 不该因为跑了一次就凭空建出一个库目录，
  // 而且 `src://` 在仓库语境下本来就没有来源层可查（CI 只解析 file://，ADR-0009）。
  if (args.repo) {
    const scanned = readRepoAssets(process.cwd());
    const index = buildSpanIndex({ sources: null, workspaces: [process.cwd()] });
    return reportLint(scanned, index, args.today);
  }

  const vault = openVault(root);
  return reportLint(vault.assets.scan(), vault.spanIndex([root]), args.today);
}

/**
 * @param {{docs: import("@forge/schema").AssetDoc[]; invalid: {path: string; reason: string}[]}} scanned
 * @param {import("@forge/core").SpanIndex} index
 * @param {string | null} today
 * @returns {number}
 */
function reportLint(
  scanned: { docs: import("@forge/schema").AssetDoc[]; invalid: { path: string; reason: string }[] },
  index: import("@forge/core").SpanIndex,
  today: string | null,
): number {
  const violations: Violation[] = [
    ...scanned.invalid.map((item) => ({
      code: "ASSET_FRONTMATTER_INVALID",
      path: item.path,
      message: `front-matter 读不动：${item.reason}`,
      fix: "补全 front-matter（字段表见 schema/taxonomy.yaml）；半吊子的 front-matter 比没有更难查",
    })),
    ...judgeLibrary(scanned.docs, index),
  ];

  if (today !== null) {
    violations.push(...scanned.docs.flatMap((doc) => checkFreshness(doc, today)));
  }

  const sorted = sortViolations(violations);
  if (sorted.length === 0) {
    out(`✓ 审核通过：${scanned.docs.length} 条资产（schema v${SCHEMA_VERSION}）`);
    return 0;
  }

  err(`✗ 审核发现 ${sorted.length} 处问题（${scanned.docs.length} 条资产）：`);
  for (const violation of sorted) err(formatViolation(violation));
  err("");
  err("  闸门红了要修**问题**，不是修闸门。");
  return 1;
}

/**
 * `forge bootstrap` —— 自举（S29）。
 *
 * 它把"用本项目自己的 CLI 管本项目"从一句口号变成一条命令：
 * 读**仓库自己的资产**（`readRepoAssets`，与 `forge lint --repo` 同一份集合），
 * 用**同一套判定**（`judgeLibrary`）审出处，再核对种子规则、尺子的确认状态、
 * 两个对外产物，以及团队版有没有在没信号的时候先长出来。
 *
 * 它不改任何东西：红了就退出 1，修法是去修资产/重新生成产物，而不是调松这里。
 *
 * @returns {number}
 */
function runBootstrap(): number {
  const root = process.cwd();
  const scanned = readRepoAssets(root);
  const spanIndex = buildSpanIndex({ sources: null, workspaces: [root] });
  const violations = judgeLibrary(scanned.docs, spanIndex);

  const seedRules = readSeedRules(root);
  const evalReview = readEvalReview(root);

  // 两个对外产物都用**同一份仓库资产**重算，然后逐字节比对。
  // 手工改产物会在这一步现形；这也是"第二份真相一定会漂移"的执行体。
  const artifacts: BootstrapArtifact[] = [
    compareArtifact(root, "listing", emitListing({ assets: scanned.docs, events: [] })),
    compareArtifact(root, "demo", emitDemo({ assets: scanned.docs, events: [] }, { source: "repo" })),
  ];

  const result = evaluateBootstrap({
    assets: scanned.docs,
    invalid: scanned.invalid,
    violations,
    seedRules,
    evalReview,
    team: readTeamStatus(root),
    artifacts,
  });

  out(renderBootstrapReport(result));
  if (!result.ok) {
    err("");
    err("  自举闸门红了要修**问题**：补出处、重新生成产物、或者把团队能力关掉。");
    err("  不要为了让这条命令变绿而调松判据——那样它就不再是一条闸门。");
    return 1;
  }
  return 0;
}

/**
 * `forge listing` —— 上架包（S31）。
 *
 * 产物**永远自称 draft**（见 `packages/core/src/distribution.ts`）：
 * 生成条目是机器能做的最后一步，提交与审核必须由人完成。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runListing(args: ParsedArgs): number {
  if (args.out === null) {
    err("✗ listing 必须给 --out <目录>：上架包写哪儿是个决定，不该有默认值。");
    return 2;
  }
  const collected = collectProjectionInput(args);
  if (!collected.ok) return collected.code;

  const options = args.title === null ? {} : { title: args.title };
  return writeProjection(args, emitListing(collected.input, options), "上架包");
}

/**
 * `forge demo` —— 对外 demo（S32）。
 *
 * 输入只有库本身：默认读 vault，`--repo` 时读本仓库自己的资产。
 * **没有样例数据入口**——这不是"暂时没做"，是这个命令存在的理由。
 *
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runDemo(args: ParsedArgs): number {
  if (args.out === null) {
    err("✗ demo 必须给 --out <目录>：演示站写哪儿是个决定，不该有默认值。");
    return 2;
  }
  const collected = collectProjectionInput(args);
  if (!collected.ok) return collected.code;

  const options = {
    source: collected.source,
    ...(args.title === null ? {} : { title: args.title }),
  };
  return writeProjection(args, emitDemo(collected.input, options), "演示站");
}

interface ProjectionInput {
  assets: AssetDoc[];
  events: EventIR[];
}

/**
 * 取投影的输入。仓库模式与库模式共用同一条错误路径：
 * **读不动的资产会让投影静默漏掉**，而"漏掉"和"没有"在产物里看起来一样。
 *
 * @param {ParsedArgs} args
 * @returns {{ ok: true, input: ProjectionInput, source: "repo" | "vault" } | { ok: false, code: number }}
 */
function collectProjectionInput(
  args: ParsedArgs,
): { ok: true; input: ProjectionInput; source: "repo" | "vault" } | { ok: false; code: number } {
  if (args.repo) {
    const scanned = readRepoAssets(process.cwd());
    if (scanned.invalid.length > 0) {
      err(`✗ 有 ${scanned.invalid.length} 个文件读不成资产，拒绝生成：`);
      for (const item of scanned.invalid) err(`  - ${item.path}：${item.reason}`);
      return { ok: false, code: 1 };
    }
    return { ok: true, input: { assets: scanned.docs, events: [] }, source: "repo" };
  }

  const vault = openVault(resolve(args.vault));
  const scan = vault.assets.scan();
  if (scan.invalid.length > 0) {
    err(`✗ 有 ${scan.invalid.length} 个文件读不成资产，拒绝生成：`);
    for (const item of scan.invalid) err(`  - ${item.path}：${item.reason}`);
    return { ok: false, code: 1 };
  }
  const { events } = vault.derive();
  return { ok: true, input: { assets: scan.docs, events }, source: "vault" };
}

/**
 * 写盘或只比对。与 `emit --check` 同一条纪律：一致时退出 0，不一致时退出 1。
 *
 * @param {ParsedArgs} args
 * @param {import("@forge/core").EmittedFile[]} files
 * @param {string} label
 * @returns {number}
 */
function writeProjection(args: ParsedArgs, files: import("@forge/core").EmittedFile[], label: string): number {
  const outDir = resolve(args.out ?? "");
  // 上一份清单决定"哪些旧文件可以删"：只删上一轮生成器写过、这一轮没有的文件。
  // 目录里人放的东西（CNAME、LICENSE）不在清单里，所以永远不会被这里碰到。
  const previous = readProjectionManifest(outDir);
  const stale = stalePaths(previous, files);

  if (args.check) {
    const drifted = files.filter((file) => {
      const target = join(outDir, file.path);
      return !existsSync(target) || readFileSync(target, "utf8") !== file.content;
    });
    const staleDrift = stale.map((path) => `${path}（上一轮产物，已不在这一轮）`);
    if (drifted.length === 0 && staleDrift.length === 0) {
      out(`✓ ${label}与库一致：${String(files.length)} 个文件逐字节相同`);
      return 0;
    }
    err(`✗ ${label}与库不一致（${String(drifted.length + staleDrift.length)} 处）：`);
    for (const file of drifted) err(`  - ${file.path}`);
    for (const path of staleDrift) err(`  - ${path}`);
    err("  重新生成它。手工改产物等于制造第二份真相。");
    return 1;
  }

  for (const path of stale) {
    const target = join(outDir, path);
    if (existsSync(target)) unlinkSync(target);
  }
  for (const file of files) {
    const target = join(outDir, file.path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  out(`✓ ${label}完成：${String(files.length)} 个文件 → ${outDir}`);
  return 0;
}

/**
 * 读并解析 AGENTS.md 的种子规则。
 *
 * 它**直接复用闸门 1 的解析器**（`scripts/gates/lib/harness.mjs`）：
 * 自举报告与闸门对"这条规则有没有出处"必须给出同一个答案。
 * 各写一份的结局是报告说绿、闸门说红——而那种分歧只会训练人去信报告。
 *
 * @param {string} root
 * @returns {SeedRulesInput | null}
 */
function readSeedRules(root: string): SeedRulesInput | null {
  try {
    const text = readFileSync(join(root, "AGENTS.md"), "utf8");
    const parsed = parseAgentRules(text);
    return {
      count: parsed.count,
      ids: parsed.ids,
      missingOrigin: parsed.missingOrigin,
      maxRules: AGENTS_MD_MAX_RULES,
    };
  } catch {
    return null;
  }
}

/**
 * 读两把尺子的确认记录与阈值批准状态。
 *
 * 自举**不重新算分数**：分数是 `evals/runner` 的事。这里只回答
 * "人有没有为这份内容签过字"，因为 S29 要自举的是**质量门的存在**，不是再跑一遍尺子。
 *
 * @param {string} root
 * @returns {EvalReviewInput | null}
 */
function readEvalReview(root: string): EvalReviewInput | null {
  const extraction = readJsonObject(join(root, "evals", "golden", "extraction", "cases.json"));
  const conflict = readJsonObject(join(root, "evals", "golden", "conflict", "cases.json"));
  const thresholds = readJsonObject(join(root, "evals", "thresholds.json"));
  if (extraction === null || conflict === null || thresholds === null) return null;

  const reviewOf = (value: Record<string, unknown>): { status: string; reviewed_by: string | null } => {
    const review = value["review"];
    if (typeof review !== "object" || review === null) return { status: "proposed", reviewed_by: null };
    const record = review as Record<string, unknown>;
    return {
      status: typeof record["status"] === "string" ? record["status"] : "proposed",
      reviewed_by: typeof record["reviewed_by"] === "string" ? record["reviewed_by"] : null,
    };
  };

  const extractionBlock = thresholds["extraction"];
  const ratifiedBy =
    typeof extractionBlock === "object" && extractionBlock !== null
      ? (extractionBlock as Record<string, unknown>)["ratified_by"]
      : null;

  return {
    extraction: reviewOf(extraction),
    conflict: reviewOf(conflict),
    thresholdsRatifiedBy: typeof ratifiedBy === "string" ? ratifiedBy : null,
  };
}

/**
 * 读 `docs/team/status.json` 并判定团队版该不该存在。
 *
 * 文件不存在等于"没有信号"——这是默认状态，不是错误。**但能力默认全关**：
 * 一个没写下来的开关不能被读成已打开。解析与判定都在 `packages/core/src/team.ts`，
 * 于是自举报告与 `evals/` 探针对同一份文件给出同一个答案。
 *
 * @param {string} root
 * @returns {import("@forge/core").TeamStatus}
 */
function readTeamStatus(root: string): import("@forge/core").TeamStatus {
  return teamStatusFromConfig(readJsonObject(join(root, "docs", "team", "status.json")));
}

/**
 * @param {string} path
 * @returns {Record<string, unknown> | null}
 */
function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 把生成器期望的文件与磁盘上的产物逐字节比对。
 *
 * @param {string} root
 * @param {string} name
 * @param {import("@forge/core").EmittedFile[]} files
 * @returns {BootstrapArtifact}
 */
function compareArtifact(
  root: string,
  name: string,
  files: import("@forge/core").EmittedFile[],
): BootstrapArtifact {
  const state = inspectProjection(join(root, name), files);
  return { name, expected: files.length, missing: state.missing, drifted: state.drifted };
}

/**
 * @param {ParsedArgs} args
 * @returns {number}
 */
function runEmit(args: ParsedArgs): number {
  if (args.out === null) {
    err("✗ emit 必须给 --out <目录>：投影写哪儿是个决定，不该有默认值。");
    return 2;
  }

  const vault = openVault(resolve(args.vault));
  const scan = vault.assets.scan();
  if (scan.invalid.length > 0) {
    err(`✗ 有 ${scan.invalid.length} 个文件读不成资产，拒绝 emit：`);
    for (const item of scan.invalid) err(`  - ${item.path}：${item.reason}`);
    err("  投影会把坏资产静默漏掉，而「漏掉」和「没有」看起来是一样的。");
    return 1;
  }

  // 事件从**来源重新推导**，不读索引：索引是可重建的缓存（ADR-0015），
  // 让 emit 依赖缓存会让"忘了先 compile"变成一份悄悄少了一节的 AGENTS.md。
  const { events } = vault.derive();
  const input = { assets: scan.docs, events };
  const options = args.title === null ? {} : { title: args.title };
  const files = emitLibrary(input, options);
  // v2 的两个出口与 v1 同源：同一批资产，喂给不同的消费者（ADR-0033）。
  // 它们是**投影**，所以谁都不是作者——删掉重跑就是了。
  if (args.skill) files.push(...emitSkill(input, options));
  if (args.evals) files.push(evalExportFile(emitEvalCases(input)));
  const outDir = resolve(args.out);

  const drifted: string[] = [];
  for (const file of files) {
    const target = join(outDir, file.path);
    const existing = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (args.check) {
      if (existing !== file.content) drifted.push(file.path);
      continue;
    }
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }

  if (args.check) {
    if (drifted.length === 0) {
      out(`✓ 投影与库一致：${files.length} 个文件逐字节相同`);
      return 0;
    }
    err(`✗ 投影与库不一致（${drifted.length} 个文件）：`);
    for (const path of drifted) err(`  - ${path}`);
    return 1;
  }

  out(`✓ emit 完成：${files.length} 个文件 → ${outDir}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    err(`✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
