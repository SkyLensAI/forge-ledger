/**
 * 团队版的**闸门** —— 纯函数，零 IO（S30）。
 *
 * implement2.md 给 S30 写的第一句话是"**只在出现付费信号后**做"。
 * 这句话如果只写在文档里，它就会像所有礼貌指令一样在某天被顺手绕过去：
 * 有人先加了权限、先加了同步，然后说"反正迟早要做"。
 *
 * 这个模块把那句话变成一次**可判定的输入**：
 *
 * - 付费信号是一个**人**填进来的字符串（不是代码猜的，也不是模型编的）；
 * - 三项能力（权限 / 并发 / 敏感度切分）是三个布尔值；
 * - 没有付费信号时，任何一项能力为真都算**违规**，而不是"提前做了"。
 *
 * 代码证明不了"真的有人付钱"。它能做的是：**不让一个没有信号的仓库
 * 在报告里看起来已经具备团队版**。这是本仓库反复用的那条分工——
 * 人负责判断，代码负责不信任（ADR-0022）。
 */

/**
 * 单人模式走向团队版的三个缺失项（implement2.md S30 原文）：
 * 没权限、没并发、没敏感度切分。
 *
 * **顺序是契约**：报告、清单与测试都按这个顺序输出（R6）。
 * 改成按 `Object.keys` 的顺序，报告就会随代码路径漂移。
 */
export const TEAM_CAPABILITIES = ["permissions", "concurrency", "sensitivity"] as const;

export type TeamCapability = (typeof TEAM_CAPABILITIES)[number];

/** 能力的中文名。只在这里写一次——三处各写一份，迟早会有一处写成别的意思。 */
export const TEAM_CAPABILITY_LABELS: Readonly<Record<TeamCapability, string>> = {
  permissions: "权限",
  concurrency: "并发",
  sensitivity: "敏感度切分",
};

/** 团队版状态的码。它们是给人看的，不是闸门码（闸门码住在 `evals/runner/gate.ts`）。 */
export const TEAM_CODES = {
  /** 没有付费信号。这不是错误，是 S30 的**前提条件还没发生**。 */
  NO_PAYMENT_SIGNAL: "TEAM_NO_PAYMENT_SIGNAL",
  /** 没有信号却已经打开了一项能力——这才是违规。 */
  CAPABILITY_WITHOUT_SIGNAL: "TEAM_CAPABILITY_WITHOUT_SIGNAL",
  /** 有信号，但三项能力还没到齐：可以开工，但不能自称完成。 */
  CAPABILITIES_MISSING: "TEAM_CAPABILITIES_MISSING",
} as const;

export interface TeamViolation {
  code: string;
  message: string;
  fix: string;
}

/**
 * 输入只有两样东西：**人给的信号**与**代码里真实存在的开关**。
 *
 * `capabilities` 用 `Partial`：缺省等于 false。这样"忘了写"与"明确没做"
 * 在判定上一致，而报告里会把它列为缺失——不会静默算作完成。
 */
export interface TeamStatusInput {
  paymentSignal: string | null;
  capabilities: Partial<Record<TeamCapability, boolean>>;
}

export interface TeamStatus {
  /** `deferred` = 还没到做的时候；`partial` = 信号有了，能力没齐；`ready` = 可以自称团队版。 */
  eligibility: "deferred" | "partial" | "ready";
  eligible: boolean;
  paymentSignal: string | null;
  /** 还没做的能力。顺序固定（见 `TEAM_CAPABILITIES`）。 */
  missing: TeamCapability[];
  /** 违规：没有信号却开了能力。**只有这一项会让自举闸门变红。** */
  violations: TeamViolation[];
}

/**
 * 判定团队版现在该不该存在、以及它有没有在没信号的时候先长出来。
 *
 * @param {TeamStatusInput} input
 * @returns {TeamStatus}
 */
export function evaluateTeamEdition(input: TeamStatusInput): TeamStatus {
  const paymentSignal = normalizeSignal(input.paymentSignal);
  const missing = TEAM_CAPABILITIES.filter((capability) => input.capabilities[capability] !== true);
  const violations: TeamViolation[] = [];

  if (paymentSignal === null) {
    const opened = TEAM_CAPABILITIES.filter((capability) => input.capabilities[capability] === true);
    for (const capability of opened) {
      violations.push({
        code: TEAM_CODES.CAPABILITY_WITHOUT_SIGNAL,
        message:
          `没有付费信号，但「${TEAM_CAPABILITY_LABELS[capability]}」已经被打开了。` +
          `implement2.md S30 的前提是**出现付费信号之后**再做团队功能——` +
          `先做了再补信号，等于把顺序反过来，而顺序是这一节唯一的内容。`,
        fix: "要么把这项能力关掉，要么在 docs/team/status.json 里记录真实的付费信号（由人填写）",
      });
    }
    return {
      eligibility: "deferred",
      eligible: false,
      paymentSignal: null,
      missing,
      violations,
    };
  }

  if (missing.length > 0) {
    return {
      eligibility: "partial",
      eligible: false,
      paymentSignal,
      missing,
      violations,
    };
  }

  return {
    eligibility: "ready",
    eligible: true,
    paymentSignal,
    missing: [],
    violations,
  };
}

/**
 * 报告里的团队版一行。**没有信号时也必须说话**：
 * 一句沉默会被读成"团队版已经就绪"，而沉默与"还没做"是两件事。
 *
 * @param {TeamStatus} status
 * @returns {string}
 */
export function renderTeamStatus(status: TeamStatus): string {
  const signal = status.paymentSignal === null ? "无" : `有（${status.paymentSignal}）`;
  const missing =
    status.missing.length === 0
      ? "无"
      : status.missing.map((capability) => TEAM_CAPABILITY_LABELS[capability]).join(" / ");
  return (
    `团队版：${status.eligibility}（付费信号：${signal}；缺失能力：${missing}）` +
    " —— S30：只在出现付费信号后做，且权限 / 并发 / 敏感度切分三项缺一不可"
  );
}

/**
 * 从 `docs/team/status.json` 的解析结果判定团队版。
 *
 * 解析放在这里而不是宿主里：CLI 的自举报告与 `evals/` 的探针必须对
 * "有没有信号、哪项能力开着"给出**同一个答案**。两边各写一份的结局，
 * 是报告说没开、探针说开了——而人只会相信对自己有利的那一份。
 *
 * 读不到、形状不对、字段类型不对，一律按"没有信号 + 能力全关"处理。
 * 这是保守方向：**不会**把一份坏配置读成"团队版已启用"。
 *
 * @param {unknown} config
 * @returns {TeamStatus}
 */
export function teamStatusFromConfig(config: unknown): TeamStatus {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : ({} as Record<string, unknown>);
  const paymentSignal = typeof raw["payment_signal"] === "string" ? (raw["payment_signal"] as string) : null;
  const rawCapabilities =
    typeof raw["capabilities"] === "object" && raw["capabilities"] !== null
      ? (raw["capabilities"] as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const capabilities: Partial<Record<TeamCapability, boolean>> = {};
  for (const capability of TEAM_CAPABILITIES) {
    capabilities[capability] = rawCapabilities[capability] === true;
  }
  return evaluateTeamEdition({ paymentSignal, capabilities });
}

/**
 * 付费信号归一化：空白等于没有。
 *
 * 为什么不用 `Boolean(value)`：`"   "` 会被读成"有信号"，于是任何人都能
 * 用一个空格解锁团队版。信号的内容是什么不重要，**它必须是一个真人写下的非空字符串**。
 *
 * @param {string | null} value
 * @returns {string | null}
 */
function normalizeSignal(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
