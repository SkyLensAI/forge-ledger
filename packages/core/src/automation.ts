/**
 * 自动化政策 + 配方（docs/automation.md）。
 *
 * 这份文档回答的是"哪些动作可以交给机器"，而文档本身不会拦人。
 * 这里把它的三档判断变成**数据 + 纯函数**：
 *
 * | 档 | 含义 | 代码怎么处理 |
 * |---|---|---|
 * | `unattended` | 结果确定 / 可逆 / 错了只是多一条噪音 | 可以写进生成的流水线 |
 * | `prepare` | 机器把证据准备好，最后一下由人点 | 允许出现在文档里，**不许**出现在可执行文件里 |
 * | `forbidden` | 做了就会拆掉信任模型 | 连生成物里都不出现 |
 *
 * 三个"点头"动作（`inbox --promote` / `conflicts --resolve` / `confirm`）
 * 是这份政策的中心。它们在技术上能脚本化，但在流程上必须由人触发；
 * `inspectAutomation()` 扫的是**可执行行**（注释与 `README.md` 不算），
 * 所以"在注释里解释为什么不能自动化"不会被误判。
 *
 * 零 IO、零时钟、零随机（R5）：配方是输入的函数，同一组输入逐字节相同（R6）。
 */
import type { EmittedFile } from "./emit.ts";
import { withProjectionManifest } from "./projection.ts";

/** 三档。顺序就是 `--list` 的展示顺序，也是判断的优先级。 */
export const AUTOMATION_TIERS = ["unattended", "prepare", "forbidden"] as const;
export type AutomationTier = (typeof AUTOMATION_TIERS)[number];

export interface AutomationAction {
  /** 稳定的 kebab-case 标识；测试与文档用它引用同一条。 */
  id: string;
  tier: AutomationTier;
  /** 人读的动作名。 */
  name: string;
  /** 命令 / 入口（展示用，不代表这里会执行它）。 */
  entry: string;
  /** 为什么它在这一档。 */
  why: string;
  /** `prepare` 档：必须由人做的那一步。 */
  human?: string;
  /** `prepare` / `forbidden` 档：系统给的保险。 */
  guard?: string;
}

export interface HumanOnlyInvocation {
  /** 与 `AutomationAction.id` 对应。 */
  id: string;
  /** 出现在配方里就等于越界的那一条命令。 */
  entry: string;
  /** 只匹配命令文本；调用方负责先剥掉注释。 */
  pattern: RegExp;
  message: string;
}

export interface AutomationFinding {
  path: string;
  /** 1 起算。 */
  line: number;
  code: "AUTOMATION_HUMAN_ACTION" | "AUTOMATION_GATE_BYPASS";
  message: string;
}

export interface AutomationOptions {
  /**
   * 写进脚本的 forge 命令。默认 `forge`。
   * 运行时仍然可以用环境变量 `FORGE_BIN` 覆盖——生成的配方不该把安装位置写死。
   */
  forgeBin?: string;
  /**
   * cron / Task Scheduler 启动脚本时的工作目录。默认 `.`。
   * CLI 传 `process.cwd()`；传绝对路径才能让计划任务找得到脚本。
   */
  workdir?: string;
  /**
   * 这套配方生成到哪个目录。默认 `.`（= 工作目录本身）。
   * 调度器必须从**生成目录**启动 `pipeline.sh` / `pipeline.ps1`，
   * 而不是从工作目录猜一个同名文件。
   */
  bundleDir?: string;
}

/**
 * 三档政策。与 docs/automation.md 的三张表一一对应。
 *
 * 只把**判断**搬进来，不搬正文：文档继续负责解释"为什么"，
 * 这份数据负责让测试与生成器引用同一条判据，而不是各抄一份。
 */
export const AUTOMATION_ACTIONS: readonly AutomationAction[] = [
  // ── 一、可以全自动（无人值守）────────────────────────────────────────────
  {
    id: "compile-import",
    tier: "unattended",
    name: "来源导入与编译",
    entry: "forge compile --import <文件>",
    why: "确定性转换；ID 内容寻址，重复导入不产生重复事件。",
  },
  {
    id: "browser-capture",
    tier: "unattended",
    name: "浏览器采集",
    entry: "扩展 + forge serve",
    why: "只写 sources/（只读层），不做判定。",
  },
  {
    id: "extract-replay",
    tier: "unattended",
    name: "抽取（回放）",
    entry: "forge extract --cassette <文件>",
    why: "录像键是提示词指纹，不调网络；两次运行候选区字节相同。",
  },
  {
    id: "extract-record",
    tier: "unattended",
    name: "抽取（真实模型）",
    entry: "forge extract --record --model … --endpoint …",
    why: "技术上可定时跑；产出只进 _inbox/，不进 assets/。",
  },
  {
    id: "link",
    tier: "unattended",
    name: "归并提议",
    entry: "forge link",
    why: "只出报告/候选，不改写任何字节。",
  },
  {
    id: "conflict-detect",
    tier: "unattended",
    name: "冲突探测",
    entry: "forge link / forge conflicts（只读列表）",
    why: "只出候选 + 证据；ConflictCandidate 里没有「应用」这一档。",
  },
  {
    id: "retrieve-context",
    tier: "unattended",
    name: "检索与注入",
    entry: "forge context \"…\" --budget N",
    why: "纯函数打分；预算内、带出处；MCP 的四个工具全是只读。",
  },
  {
    id: "emit-projection",
    tier: "unattended",
    name: "多出口投影",
    entry: "forge emit --out … / --skill / --evals",
    why: "逐字节确定；--check 不一致退出 1。",
  },
  {
    id: "reconcile-products",
    tier: "unattended",
    name: "产物对账",
    entry: "forge listing --check、forge demo --check",
    why: "只比对不写盘。",
  },
  {
    id: "health-read",
    tier: "unattended",
    name: "健康检查（只读）",
    entry: "forge health --today …",
    why: "只读，不打分，不自动修。",
  },
  {
    id: "health-due",
    tier: "unattended",
    name: "新鲜度巡检",
    entry: "forge health --today … --due",
    why: "有到期项退出 1，适合 cron 触发提醒。",
  },
  {
    id: "audit-verify",
    tier: "unattended",
    name: "审计链校验",
    entry: "forge audit --verify",
    why: "只读；链断退出非零。",
  },
  {
    id: "weekly-report",
    tier: "unattended",
    name: "周报生成",
    entry: "forge weekly --today … --days 7 --out report.md",
    why: "纯投影，可进定时任务。",
  },
  {
    id: "bootstrap",
    tier: "unattended",
    name: "自举判定",
    entry: "forge bootstrap",
    why: "六项检查，通过/不通过。",
  },
  {
    id: "index-rebuild",
    tier: "unattended",
    name: "索引重建",
    entry: "由 store 内部自动完成",
    why: "index/ 本来就设计成可删可重建。",
  },
  {
    id: "selector-hot-update",
    tier: "unattended",
    name: "选择器热更新",
    entry: "forge serve --selectors <URL>",
    why: "平台改版时改配置，不必重发扩展。",
  },
  {
    id: "mcp-config",
    tier: "unattended",
    name: "MCP 配置生成",
    entry: "forge mcp-config --client …",
    why: "从 clients.json 生成，无副作用。",
  },
  {
    id: "gates",
    tier: "unattended",
    name: "五道闸门",
    entry: "gate:precommit / gate:ci / gate:trusted / gate:rehearse",
    why: "已经是自动化的；CI 是权威。",
  },

  // ── 二、可以自动准备，不能自动裁决 ───────────────────────────────────────
  {
    id: "candidate-promote",
    tier: "prepare",
    name: "候选入库",
    entry: "forge inbox --promote <id> --date … --confidence …",
    why: "抽取、去重、置信度、出处重建都可以自动；最后一下是人的判断。",
    human: "forge inbox --promote <id> --date … --confidence …",
    guard: "模型产出永远进 _inbox/；origin === \"model\" 不可配置。",
  },
  {
    id: "conflict-resolve",
    tier: "prepare",
    name: "冲突处理",
    entry: "forge conflicts --resolve --decision replace/keep/defer --date --rationale",
    why: "检测、证据收集、新旧两侧原文对齐可以自动；判哪边成立不行。",
    human: "forge conflicts --resolve --decision … --date … --rationale …",
    guard: "冲突永不自动应用；replace 必填日期、理由、置信度。",
  },
  {
    id: "state-confirm",
    tier: "prepare",
    name: "状态续期",
    entry: "forge confirm <id> --date … --note …",
    why: "health --due 可以找出到期项、生成提醒；续期必须由人回答。",
    human: "forge confirm <id> --date … --note …",
    guard: "没有 --auto-confirm（ADR-0036）；自动刷新会让库永远「新鲜」。",
  },
  {
    id: "merge-approve",
    tier: "prepare",
    name: "归并成立",
    entry: "forge link（提议）→ 人判断",
    why: "link 可以出提议与报告；「这两条是不是同一件事」由人决定。",
    human: "判断归并提议是否成立",
    guard: "proposedMergesApplied() 自证提议没被自动应用。",
  },
  {
    id: "sensitivity-classify",
    tier: "prepare",
    name: "敏感度分级",
    entry: "建议 → 人定级",
    why: "可以自动给建议；public/internal/private 的定级由人承担。",
    human: "给资产定级（public / internal / private）",
    guard: "当前没有自动敏感性过滤；上传云库明确不做。",
  },
  {
    id: "release",
    tier: "prepare",
    name: "发布",
    entry: "预检 → 人按发布键",
    why: "版本、依赖链、files/engines 预检可以自动；对外发布不行。",
    human: "按下发布键、走平台审核",
    guard: "release.yml 的 environment: release + 人工审批。",
  },
  {
    id: "schema-migration",
    tier: "prepare",
    name: "schema / 迁移",
    entry: "迁移脚本 → 人决定是否改",
    why: "迁移脚本可以自动跑；是否改 schema/taxonomy、写哪条 ADR 由人决定。",
    human: "决定改不改 schema/taxonomy 并写 ADR",
    guard: "受保护路径 + A1_PROTECTED_PATH；必须同变更集带 ADR。",
  },

  // ── 三、设计上禁止自动化 ────────────────────────────────────────────────
  {
    id: "model-to-assets",
    tier: "forbidden",
    name: "模型产出直接进 assets/",
    entry: "(不存在)",
    why: "一次编造就是一次信任崩塌。",
    guard: "origin === \"model\" 不可配置；守卫每次 CI 用敌意模型探针验证。",
  },
  {
    id: "conflict-auto-apply",
    tier: "forbidden",
    name: "冲突自动覆盖旧状态",
    entry: "(不存在)",
    why: "两条事实被压成一条且看不出来。",
    guard: "冲突只能出候选；resolve 必填理由。",
  },
  {
    id: "auto-confirm",
    tier: "forbidden",
    name: "自动刷新 last_confirmed",
    entry: "(不存在)",
    why: "库会永远看起来新鲜，「过期」这个唯一信号消失。",
    guard: "没有该开关；confirm 只动人触发的那一个字段。",
  },
  {
    id: "auto-apply-merges",
    tier: "forbidden",
    name: "自动应用模型归并提议",
    entry: "(不存在)",
    why: "假阳性不可见。",
    guard: "proposedMergesApplied() 断言为 0。",
  },
  {
    id: "bypass-gates",
    tier: "forbidden",
    name: "绕过闸门",
    entry: "(不存在)",
    why: "本地可绕过，权威在 CI。",
    guard: "--no-verify / --force / 改 hooksPath 被 policy 判红；闸门代码取自基线修订。",
  },
  {
    id: "agent-schema-change",
    tier: "forbidden",
    name: "agent 自主改 schema / taxonomy / 迁移",
    entry: "(不存在)",
    why: "不可逆，迁移成本随数据量线性增长。",
    guard: "保护路径直接阻断，且需新增 ADR。",
  },
  {
    id: "team-without-payment",
    tier: "forbidden",
    name: "没有付费信号就开团队能力",
    entry: "(不存在)",
    why: "顺序错了会拆掉安全模型。",
    guard: "docs/team/status.json 的 payment_signal 仍是 null；E16 判红。",
  },
  {
    id: "auto-publish",
    tier: "forbidden",
    name: "发布",
    entry: "(不存在)",
    why: "对外、不可逆。",
    guard: "人工审批 + preflight。",
  },
  {
    id: "preload-context",
    tier: "forbidden",
    name: "预加载全库进上下文",
    entry: "(不存在)",
    why: "context rot；相关性是任务相对的。",
    guard: "E11 对照查询必须零注入。",
  },
  {
    id: "upload-private",
    tier: "forbidden",
    name: "自动上传私有资产",
    entry: "(不存在)",
    why: "没有敏感度隔离。",
    guard: "个人版明确不做云同步 / 公网 API。",
  },
];

/**
 * 三个必须由人触发的动作。技术上都能脚本化——这正是为什么要用生成器 +
 * 测试把"配方里不许出现它们"钉住，而不是只在文档里请求。
 *
 * 正则只匹配命令本身；`inspectAutomation` 会先剥掉注释，
 * 所以"在脚本里解释为什么不能自动化"不会被误判。
 */
export const HUMAN_ONLY_INVOCATIONS: readonly HumanOnlyInvocation[] = [
  {
    id: "candidate-promote",
    entry: "forge inbox --promote",
    pattern: /\binbox\b[^\n]*--promote\b/,
    message: "inbox --promote 是人的「点头」：模型产出只能留在候选区，由人带日期与置信度确认。",
  },
  {
    id: "conflict-resolve",
    entry: "forge conflicts --resolve",
    pattern: /\bconflicts\b[^\n]*--resolve\b/,
    message: "conflicts --resolve 是唯一能改写已有状态的动作，必须由人带理由触发。",
  },
  {
    id: "state-confirm",
    entry: "forge confirm",
    pattern: /(?:\$forge|forge)"?\s+confirm\b/i,
    message: "confirm 回答的是「这条现在还成立吗」；自动刷新会让「过期」这个信号消失。",
  },
];

const GATE_BYPASS_PATTERNS: readonly { pattern: RegExp; message: string }[] = [
  { pattern: /--no-verify\b/, message: "--no-verify 会跳过本地闸门；闸门红了要修问题，不是改闸门。" },
  { pattern: /\bpush\b[^\n]*(?:--force\b|--force-with-lease\b)/, message: "强推会重写历史，而审计与出处依赖历史不可变。" },
  { pattern: /core\.hooksPath/, message: "改 core.hooksPath 等于摘下闸门 2。" },
  { pattern: /FORGE_GATE_OVERRIDE/, message: "自己给自己放行的开关，本身就是违宪。" },
];

const TIER_TITLES: Record<AutomationTier, string> = {
  unattended: "一、可以全自动（无人值守）",
  prepare: "二、可以自动准备，不能自动裁决",
  forbidden: "三、设计上禁止自动化",
};

/**
 * 校验政策数据本身。返回空数组 = 通过。
 *
 * 这些判据不是形式主义：`prepare` 少了 `human` 就变成了"看起来可以自动"，
 * `forbidden` 少了 `guard` 就变成了"只是建议"。
 *
 * @returns 问题列表（可直接用来报错）
 */
export function validateAutomationPolicy(actions: readonly AutomationAction[] = AUTOMATION_ACTIONS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const tier of AUTOMATION_TIERS) {
    if (!actions.some((action) => action.tier === tier)) problems.push(`档位 ${tier} 一条动作都没有`);
  }

  for (const action of actions) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(action.id)) {
      problems.push(`动作 id 必须是 kebab-case：${action.id}`);
    }
    if (seen.has(action.id)) problems.push(`动作 id 重复：${action.id}`);
    seen.add(action.id);

    if (action.entry.trim().length === 0) problems.push(`${action.id} 缺少入口`);
    if (action.why.trim().length === 0) problems.push(`${action.id} 缺少理由`);

    if (action.tier === "prepare") {
      if (action.human === undefined || action.human.trim().length === 0) {
        problems.push(`${action.id} 是 prepare 档，必须写清「人做什么」`);
      }
      if (action.guard === undefined || action.guard.trim().length === 0) {
        problems.push(`${action.id} 是 prepare 档，必须写清「系统给的保险」`);
      }
    }
    if (action.tier === "forbidden" && (action.guard === undefined || action.guard.trim().length === 0)) {
      problems.push(`${action.id} 是 forbidden 档，必须写清「强制点」`);
    }
  }

  for (const human of HUMAN_ONLY_INVOCATIONS) {
    const action = actions.find((item) => item.id === human.id);
    if (action === undefined) {
      problems.push(`人工动作 ${human.id} 在政策表里没有对应条目`);
    } else if (action.tier !== "prepare") {
      problems.push(`人工动作 ${human.id} 必须属于 prepare 档`);
    }
  }

  // 无人值守的入口里出现人工动作 = 政策自相矛盾。
  for (const action of actions.filter((item) => item.tier === "unattended")) {
    for (const human of HUMAN_ONLY_INVOCATIONS) {
      if (human.pattern.test(action.entry)) {
        problems.push(`unattended 的 ${action.id} 入口命中了人工动作 ${human.id}`);
      }
    }
  }

  return problems;
}

/**
 * `forge automate --list` 的正文。纯展示，不含任何执行。
 *
 * @returns 逐行确定的文本（末尾一个换行）
 */
export function renderAutomationPolicy(): string {
  const lines: string[] = [
    "自动化政策（docs/automation.md）",
    "",
    "判断标准：结果是否确定 → 是否可逆 → 后果由谁承担。",
    "",
  ];

  for (const tier of AUTOMATION_TIERS) {
    lines.push(TIER_TITLES[tier]);
    lines.push("");
    for (const action of AUTOMATION_ACTIONS.filter((item) => item.tier === tier)) {
      lines.push(`  ${action.id}  ·  ${action.name}`);
      lines.push(`      入口：${action.entry}`);
      lines.push(`      理由：${action.why}`);
      if (action.human !== undefined) lines.push(`      人：${action.human}`);
      if (action.guard !== undefined) lines.push(`      保险：${action.guard}`);
      lines.push("");
    }
  }

  lines.push("生成的配方只执行第一档的动作。第二档的「人」那一步不出现在任何可执行行里；");
  lines.push("第三档连生成物都不出现。");
  lines.push("");
  return lines.join("\n");
}

/**
 * 扫一份生成物，找出不该出现在自动化里的调用。
 *
 * 只扫**可执行行**：
 * - `.sh` / `.ps1` / `.cron`：剥掉 `#` 之后的内容；
 * - `.xml`：只扫 `<Arguments>` / `<Command>` / `<WorkingDirectory>`；
 * - `.md` / `.json`：不扫（文档需要解释为什么这些动作不能自动化）。
 *
 * @param files 生成物
 * @returns 按路径与行号排序的问题列表
 */
export function inspectAutomation(files: readonly EmittedFile[]): AutomationFinding[] {
  const findings: AutomationFinding[] = [];

  for (const file of files) {
    for (const { line, text } of executableLines(file)) {
      for (const human of HUMAN_ONLY_INVOCATIONS) {
        if (human.pattern.test(text)) {
          findings.push({
            path: file.path,
            line,
            code: "AUTOMATION_HUMAN_ACTION",
            message: `${human.message}（命中：${human.entry}）`,
          });
        }
      }
      for (const bypass of GATE_BYPASS_PATTERNS) {
        if (bypass.pattern.test(text)) {
          findings.push({
            path: file.path,
            line,
            code: "AUTOMATION_GATE_BYPASS",
            message: bypass.message,
          });
        }
      }
    }
  }

  return findings.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
}

/**
 * 生成可直接用的自动化配方。
 *
 * 产物全是**文本**，没有时间戳、没有随机、行尾一律 LF（R6）。
 * 它不执行任何东西：装不装、什么时候跑，是操作系统调度器的事——
 * "forge 没有内置调度器"这条边界没有被这条命令改变。
 *
 * @param options 生成参数
 * @returns 带投影清单的文件列表（按路径排序）
 */
export function renderAutomationBundle(options: AutomationOptions = {}): EmittedFile[] {
  const forgeBin = options.forgeBin ?? "forge";
  const workdir = options.workdir ?? ".";
  const bundleDir = options.bundleDir ?? ".";
  // `.` 表示"配方就生成在工作目录里"；否则调度器必须指向真实的生成目录。
  const scriptBase = bundleDir === "." ? workdir : bundleDir;

  const files: EmittedFile[] = [
    { path: "README.md", content: renderReadme(forgeBin, workdir, scriptBase) },
    { path: "pipeline.cron", content: renderCron(workdir, scriptBase) },
    { path: "pipeline.ps1", content: renderPowerShell(forgeBin) },
    { path: "pipeline.sh", content: renderBash(forgeBin) },
    { path: "task-scheduler.xml", content: renderTaskScheduler(workdir, scriptBase) },
  ];

  return withProjectionManifest("automate", files);
}

/**
 * @param forgeBin
 * @returns bash 脚本
 */
function renderBash(forgeBin: string): string {
  return [
    "#!/usr/bin/env bash",
    "# 生成物：forge automate（docs/automation.md）。**不要手改**：",
    "# 改 packages/core/src/automation.ts 后重新生成，并用 --check 对账。",
    "#",
    "# 这条流水线只调用「可以无人值守」的动作。三个必须由人做的动作",
    "# （inbox --promote / conflicts --resolve / confirm）不在任何可执行行里；",
    "# 把它们加进来会被自动化测试拦下。",
    "set -uo pipefail",
    "",
    'VAULT="${FORGE_VAULT:-$HOME/.forge}"',
    'REPORTS="${FORGE_REPORTS:-$VAULT/reports}"',
    'TODAY="${FORGE_TODAY:-$(date +%F)}"',
    `FORGE="\${FORGE_BIN:-${escapeShDouble(forgeBin)}}"`,
    "STATUS=0",
    "",
    'mkdir -p "$REPORTS"',
    "",
    "warn() {",
    '  echo "  ⚠ $1（退出码 $2）" >&2',
    "  STATUS=1",
    "}",
    "",
    "run() {",
    '  local label="$1"',
    "  shift",
    '  echo "· $label"',
    '  "$@" || warn "$label 失败" "$?"',
    "}",
    "",
    "# 1) 编译：重建索引层。幂等；不需要 API key。",
    "#    FORGE_IMPORT 给了就先导入那份导出；没给就只重建已有来源的索引。",
    'if [ -n "${FORGE_IMPORT:-}" ]; then',
    '  run "compile (import)" "$FORGE" compile --vault "$VAULT" --import "$FORGE_IMPORT"',
    "else",
    '  run "compile" "$FORGE" compile --vault "$VAULT"',
    "fi",
    "",
    "# 2) 抽取：只写候选区 _inbox/，永远不写 assets/。",
    'if [ -n "${FORGE_RECORD:-}" ] && [ -n "${FORGE_API_KEY:-}${OPENAI_API_KEY:-}" ]; then',
    '  if [ -z "${FORGE_MODEL:-}" ]; then',
    '    warn "FORGE_RECORD 需要 FORGE_MODEL" 2',
    "  else",
    '    run "extract (record)" "$FORGE" extract --vault "$VAULT" --record "$FORGE_RECORD" --model "$FORGE_MODEL"',
    "  fi",
    'elif [ -n "${FORGE_CASSETTE:-}" ]; then',
    '  run "extract (replay)" "$FORGE" extract --vault "$VAULT" --cassette "$FORGE_CASSETTE"',
    "else",
    '  echo "· extract：跳过（设 FORGE_CASSETTE，或 FORGE_RECORD + FORGE_API_KEY + FORGE_MODEL）"',
    "fi",
    "",
    "# 3) 归并 + 冲突：只出报告与候选，不改写任何字节。",
    'echo "· link"',
    '"$FORGE" link --vault "$VAULT" > "$REPORTS/link.txt" || warn "link 失败" "$?"',
    "",
    "# 4) 只读巡检：退出码驱动告警。",
    'run "health --due" "$FORGE" health --vault "$VAULT" --today "$TODAY" --due --out "$REPORTS/due.md"',
    'run "audit --verify" "$FORGE" audit --vault "$VAULT" --verify',
    'run "weekly" "$FORGE" weekly --vault "$VAULT" --today "$TODAY" --days 7 --out "$REPORTS/weekly.md"',
    "",
    "# 5) 产物对账：只在给了目录时才跑；不替人创建第二份真相。",
    'if [ -n "${FORGE_EMIT_OUT:-}" ]; then',
    '  run "emit --check" "$FORGE" emit --vault "$VAULT" --out "$FORGE_EMIT_OUT" --check',
    "else",
    '  echo "· emit --check：跳过（设 FORGE_EMIT_OUT）"',
    "fi",
    'if [ -n "${FORGE_REPO:-}" ] && [ -n "${FORGE_LISTING_OUT:-}" ]; then',
    '  echo "· listing --check"',
    '  (cd "$FORGE_REPO" && "$FORGE" listing --repo --out "$FORGE_LISTING_OUT" --check) || warn "listing --check 失败" "$?"',
    "else",
    '  echo "· listing --check：跳过（设 FORGE_REPO 与 FORGE_LISTING_OUT）"',
    "fi",
    'if [ -n "${FORGE_REPO:-}" ] && [ -n "${FORGE_DEMO_OUT:-}" ]; then',
    '  echo "· demo --check"',
    '  (cd "$FORGE_REPO" && "$FORGE" demo --repo --out "$FORGE_DEMO_OUT" --check) || warn "demo --check 失败" "$?"',
    "else",
    '  echo "· demo --check：跳过（设 FORGE_REPO 与 FORGE_DEMO_OUT）"',
    "fi",
    "",
    'echo "✓ 自动化流水线结束（退出码 $STATUS）"',
    'exit "$STATUS"',
    "",
  ].join("\n");
}

/**
 * @param forgeBin
 * @returns PowerShell 脚本
 */
function renderPowerShell(forgeBin: string): string {
  return [
    "# 生成物：forge automate（docs/automation.md）。**不要手改**：",
    "# 改 packages/core/src/automation.ts 后重新生成，并用 --check 对账。",
    "#",
    "# 这条流水线只调用「可以无人值守」的动作。三个必须由人做的动作",
    "#（inbox --promote / conflicts --resolve / confirm）不在任何可执行行里。",
    "$ErrorActionPreference = 'Continue'",
    "",
    "$Vault = if ($env:FORGE_VAULT) { $env:FORGE_VAULT } elseif ($HOME) { Join-Path $HOME '.forge' } else { '.forge' }",
    "$Reports = if ($env:FORGE_REPORTS) { $env:FORGE_REPORTS } else { Join-Path $Vault 'reports' }",
    "$Today = if ($env:FORGE_TODAY) { $env:FORGE_TODAY } else { Get-Date -Format 'yyyy-MM-dd' }",
    `$Forge = if ($env:FORGE_BIN) { $env:FORGE_BIN } else { '${escapePs(forgeBin)}' }`,
    "$script:Status = 0",
    "",
    "New-Item -ItemType Directory -Force -Path $Reports | Out-Null",
    "",
    "function Invoke-Forge {",
    "  param([string]$Label, [string[]]$ForgeArgs)",
    '  Write-Host "· $Label"',
    "  & $Forge @ForgeArgs",
    "  if ($LASTEXITCODE -ne 0) {",
    '    Write-Warning "$Label 失败（退出码 $LASTEXITCODE）"',
    "    $script:Status = 1",
    "  }",
    "}",
    "",
    "if ($env:FORGE_IMPORT) {",
    "  Invoke-Forge 'compile (import)' @('compile', '--vault', $Vault, '--import', $env:FORGE_IMPORT)",
    "} else {",
    "  Invoke-Forge 'compile' @('compile', '--vault', $Vault)",
    "}",
    "",
    "if ($env:FORGE_RECORD -and ($env:FORGE_API_KEY -or $env:OPENAI_API_KEY)) {",
    "  if (-not $env:FORGE_MODEL) {",
    "    Write-Warning 'FORGE_RECORD 需要 FORGE_MODEL'",
    "    $script:Status = 1",
    "  } else {",
    "    Invoke-Forge 'extract (record)' @('extract', '--vault', $Vault, '--record', $env:FORGE_RECORD, '--model', $env:FORGE_MODEL)",
    "  }",
    "} elseif ($env:FORGE_CASSETTE) {",
    "  Invoke-Forge 'extract (replay)' @('extract', '--vault', $Vault, '--cassette', $env:FORGE_CASSETTE)",
    "} else {",
    "  Write-Host '· extract：跳过（设 FORGE_CASSETTE，或 FORGE_RECORD + FORGE_API_KEY + FORGE_MODEL）'",
    "}",
    "",
    "Write-Host '· link'",
    "$Link = & $Forge link --vault $Vault",
    "if ($LASTEXITCODE -ne 0) { Write-Warning 'link 失败'; $script:Status = 1 }",
    "[IO.File]::WriteAllText((Join-Path $Reports 'link.txt'), (($Link -join \"`n\") + \"`n\"), [Text.UTF8Encoding]::new($false))",
    "",
    "Invoke-Forge 'health --due' @('health', '--vault', $Vault, '--today', $Today, '--due', '--out', (Join-Path $Reports 'due.md'))",
    "Invoke-Forge 'audit --verify' @('audit', '--vault', $Vault, '--verify')",
    "Invoke-Forge 'weekly' @('weekly', '--vault', $Vault, '--today', $Today, '--days', '7', '--out', (Join-Path $Reports 'weekly.md'))",
    "",
    "if ($env:FORGE_EMIT_OUT) {",
    "  Invoke-Forge 'emit --check' @('emit', '--vault', $Vault, '--out', $env:FORGE_EMIT_OUT, '--check')",
    "} else {",
    "  Write-Host '· emit --check：跳过（设 FORGE_EMIT_OUT）'",
    "}",
    "",
    "if ($env:FORGE_REPO -and $env:FORGE_LISTING_OUT) {",
    "  Write-Host '· listing --check'",
    "  Push-Location $env:FORGE_REPO",
    "  & $Forge listing --repo --out $env:FORGE_LISTING_OUT --check",
    "  if ($LASTEXITCODE -ne 0) { Write-Warning 'listing --check 失败'; $script:Status = 1 }",
    "  Pop-Location",
    "} else {",
    "  Write-Host '· listing --check：跳过（设 FORGE_REPO 与 FORGE_LISTING_OUT）'",
    "}",
    "",
    "if ($env:FORGE_REPO -and $env:FORGE_DEMO_OUT) {",
    "  Write-Host '· demo --check'",
    "  Push-Location $env:FORGE_REPO",
    "  & $Forge demo --repo --out $env:FORGE_DEMO_OUT --check",
    "  if ($LASTEXITCODE -ne 0) { Write-Warning 'demo --check 失败'; $script:Status = 1 }",
    "  Pop-Location",
    "} else {",
    "  Write-Host '· demo --check：跳过（设 FORGE_REPO 与 FORGE_DEMO_OUT）'",
    "}",
    "",
    'Write-Host "✓ 自动化流水线结束（退出码 $script:Status）"',
    "exit $script:Status",
    "",
  ].join("\n");
}

/**
 * @param workdir
 * @param scriptBase
 * @returns crontab 片段
 */
function renderCron(workdir: string, scriptBase: string): string {
  return [
    "# 生成物：forge automate —— 不要手改。安装：crontab pipeline.cron",
    "# 工作日 09:00 跑一次。输出走 cron 邮件；退出码非零表示当次流水线有信号。",
    "# TODAY 在脚本内部显式传给 --today；设 FORGE_TODAY 可以固定日期，让报告可复现（R6）。",
    "# cron 的 PATH 很短：forge 不在 /usr/local/bin 时，把 FORGE_BIN 写进 crontab 或脚本。",
    `0 9 * * 1-5 cd ${quoteSh(workdir)} && bash ${quoteSh(joinPosix(scriptBase, "pipeline.sh"))}`,
    "",
  ].join("\n");
}

/**
 * @param workdir
 * @param scriptBase
 * @returns Task Scheduler XML
 */
function renderTaskScheduler(workdir: string, scriptBase: string): string {
  const script = escapeXml(joinPosix(scriptBase, "pipeline.ps1"));
  const cwd = escapeXml(workdir);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!-- 生成物：forge automate —— 不要手改。导入：taskschd.msc → 导入任务。",
    "     触发器的起始日期是固定值（不是生成时间）；计划本身是每周一至周五 09:00。 -->",
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Forge 自动化流水线：编译、抽取、归并、巡检、审计、周报。不含入库 / 判冲突 / 续期。</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <CalendarTrigger>",
    "      <StartBoundary>2026-01-01T09:00:00</StartBoundary>",
    "      <Enabled>true</Enabled>",
    "      <ScheduleByWeek>",
    "        <DaysOfWeek>",
    "          <Monday />",
    "          <Tuesday />",
    "          <Wednesday />",
    "          <Thursday />",
    "          <Friday />",
    "        </DaysOfWeek>",
    "        <WeeksInterval>1</WeeksInterval>",
    "      </ScheduleByWeek>",
    "    </CalendarTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>powershell.exe</Command>",
    `      <Arguments>-NoProfile -ExecutionPolicy Bypass -File "${script}"</Arguments>`,
    `      <WorkingDirectory>${cwd}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\n");
}

/**
 * @param forgeBin
 * @param workdir
 * @param scriptBase
 * @returns 生成包的说明
 */
function renderReadme(forgeBin: string, workdir: string, scriptBase: string): string {
  return [
    "# Forge 自动化配方",
    "",
    "由 `forge automate --out` 生成。**不要手改**：改 `packages/core/src/automation.ts`",
    "后重新生成，并用 `forge automate --out <目录> --check` 对账。",
    "",
    "这组文件把 docs/automation.md 的三档判断落成可执行的东西：",
    "",
    "| 文件 | 用途 |",
    "|---|---|",
    "| `pipeline.sh` | Linux / macOS 的一次性流水线（cron 调用它） |",
    "| `pipeline.ps1` | Windows 的一次性流水线（任务计划程序调用它） |",
    "| `pipeline.cron` | crontab 片段：工作日 09:00 |",
    "| `task-scheduler.xml` | Windows 任务计划程序导入文件：周一至周五 09:00 |",
    "",
    `生成时记录的工作目录：\`${workdir}\`；脚本目录：\`${scriptBase}\`；forge 命令：\`${forgeBin}\`。`,
    "运行时都可以用环境变量覆盖（见下）。**路径是生成时这台机器的**：换一台机器就重新生成，",
    "不要把一个平台的配方直接搬到另一个平台。",
    "",
    "## 安装",
    "",
    "### Linux / macOS",
    "",
    "```bash",
    "crontab pipeline.cron",
    "```",
    "",
    "### Windows",
    "",
    "```powershell",
    "taskschd.msc   # 操作 → 导入任务 → 选 task-scheduler.xml",
    "```",
    "",
    "## 环境变量",
    "",
    "| 变量 | 作用 |",
    "|---|---|",
    "| `FORGE_BIN` | forge 可执行文件；默认取生成时的值 |",
    "| `FORGE_VAULT` | 资产库位置；默认 `$HOME/.forge`（Windows：`$HOME\\.forge`） |",
    "| `FORGE_REPORTS` | 报告目录；默认 `$VAULT/reports` |",
    "| `FORGE_TODAY` | 固定基准日（YYYY-MM-DD）。不设则取当天；设了才能重印同样的报告（R6） |",
    "| `FORGE_IMPORT` | 给了就先 `compile --import <文件>`；不设只重建已有来源的索引 |",
    "| `FORGE_CASSETTE` | 抽取回放用的录像；不设且没有录制参数时跳过抽取 |",
    "| `FORGE_RECORD` / `FORGE_API_KEY` / `FORGE_MODEL` | 真实模型录制；三者齐全才跑 |",
    "| `FORGE_EMIT_OUT` | 给了才跑 `emit --check` |",
    "| `FORGE_REPO` + `FORGE_LISTING_OUT` / `FORGE_DEMO_OUT` | 给了才跑 `listing` / `demo` 对账 |",
    "",
    "## 为什么这里没有入库 / 判冲突 / 续期",
    "",
    "这三个动作在技术上参数齐全就能跑，但在流程上是人的「点头」：",
    "",
    "- `forge inbox --promote …`：模型产出只能留在候选区，由人带日期与置信度确认；",
    "- `forge conflicts --resolve …`：唯一能改写已有状态的入口，必须由人带理由触发；",
    "- `forge confirm …`：回答「这条现在还成立吗」，自动刷新会让「过期」这个信号消失。",
    "",
    "因此它们不在任何可执行行里。`packages/core/src/automation.ts` 会扫描生成物，",
    "把它们混进脚本会被判红——边界写在代码里，不是写在提示词里。",
    "",
    "机器负责把东西准备到人面前，人只负责说对 / 不对。",
    "",
  ].join("\n");
}

/**
 * 只取可以执行的行。文档与 JSON 不扫：它们需要解释这些动作**为什么**不能自动化。
 *
 * @param file
 * @returns 行号（1 起算）与剥掉注释后的文本
 */
function executableLines(file: EmittedFile): Array<{ line: number; text: string }> {
  if (!/\.(sh|ps1|cmd|bat|cron|xml)$/.test(file.path)) return [];

  const lines = file.content.split("\n");
  const out: Array<{ line: number; text: string }> = [];
  for (const [index, raw] of lines.entries()) {
    if (file.path.endsWith(".xml")) {
      if (!/<(?:Arguments|Command|WorkingDirectory)>/.test(raw)) continue;
      out.push({ line: index + 1, text: raw });
      continue;
    }
    const hash = raw.indexOf("#");
    const code = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (code.length === 0) continue;
    out.push({ line: index + 1, text: code });
  }
  return out;
}

/**
 * 拼一个调度器能用的路径。统一正斜杠：cron 只认 POSIX，
 * Task Scheduler 的 PowerShell `-File` 也接受。
 *
 * @param dir 目录（`.` 表示当前目录）
 * @param file 文件名
 * @returns 拼接后的路径
 */
function joinPosix(dir: string, file: string): string {
  const normalized = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.length === 0) return `/${file}`;
  if (normalized === ".") return `./${file}`;
  return `${normalized}/${file}`;
}

/**
 * 单引号 shell 字符串。路径里的单引号用 `'\''` 断开再拼。
 *
 * @param value
 * @returns 可直接放进 shell 的带引号字符串
 */
function quoteSh(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 双引号 shell 字符串内部转义（用于 `${FORGE_BIN:-…}` 的默认值）。
 *
 * @param value
 * @returns 不含引号、可放进双引号里的文本
 */
function escapeShDouble(value: string): string {
  return value.replace(/([\\$"`])/g, "\\$1");
}

/**
 * @param value
 * @returns PowerShell 单引号字符串内部转义（单引号翻倍）
 */
function escapePs(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * @param value
 * @returns XML 文本转义
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
