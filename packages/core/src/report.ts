/**
 * 报告 —— 健康报告与周报的**渲染**。纯函数，零 IO（S25 / S28）。
 *
 * 渲染单独一个文件，因为它的纪律与判定完全不同：
 *
 * - **判定**要穷尽（少报一条就是漏掉一处腐烂）；
 * - **渲染**要克制（全部倒出来就是没人看）。
 *
 * 所以这里有两条硬规矩，它们都是 R6 的执行体：
 *
 * 1. **没有时钟。** 基准日（`today`）与周窗口都是**输入**，不是"跑的那一刻"。
 *    于是同一份库、同一个基准日跑两次，得到逐字节相同的报告——它可以被快照、
 *    被 diff、被放进邮件而不会每次都"变了"。
 * 2. **截断必须说出来。** 列 20 条就打一句"共 N 条，其余省略"。
 *    静默截断会让"一共 20 条"和"只显示 20 条"读成同一句话——那是报告在撒谎，
 *    比不确定更糟（`emit.ts` 的文件头写过同一条）。
 *
 * **不打健康分**：0–100 的数字会把"哪件事该处理"变成"怎么把数字弄回去"，
 * 而最省事的提分方式是删掉报错的那几条。报告里只有清单、计数和"先做哪三件"。
 */
import { ASSET_TYPES } from "@forge/schema";
import type { AuditEntry } from "./audit.ts";
import { AUDIT_KINDS } from "./audit.ts";
import type { HealthFinding, HealthReport } from "./health.ts";

/** 单节最多列几条证据行。**常量而非配置**：它影响输出字节（R6）。 */
export const REPORT_DETAIL_LIMIT = 20;

/**
 * 库的规模刻度。它是**参考线**，不是阈值：
 * 家酿的知识库普遍在几百条事实之后开始漂移 [14]，所以报告里要能看见
 * "离那个规模还有多远"。它**不参与任何判定**——没有一条检查挂在它上面，
 * 因为"条数到了"不是问题，"到了之后还看得见问题"才是。
 */
export const DRIFT_SCALE = { from: 500, to: 1000 } as const;

/**
 * 健康报告（S25）。
 *
 * @param {HealthReport} report
 * @param {{title?: string}} [options]
 * @returns {string}
 */
export function renderHealthReport(report: HealthReport, options: { title?: string } = {}): string {
  const title = options.title ?? "资产库";
  const lines: string[] = [];

  lines.push(`# ${title} · 健康检查`);
  lines.push("");
  lines.push(`> 基准日 ${report.today}。它是一次**输入**，不是"跑的那一刻"——`);
  lines.push("> 所以同一份库、同一个基准日跑两次，这份报告逐字节相同（R6）。");
  lines.push("> 由 `forge health --today <日期>` 生成；**它只读，不改任何东西**。");
  lines.push("");

  // ── 结论：三行，先说要不要动手 ──────────────────────────────────────────
  lines.push("## 结论");
  lines.push("");
  const errors = report.actionable.filter((finding) => finding.severity === "error").length;
  const warns = report.actionable.length - errors;
  if (report.actionable.length === 0) {
    lines.push("- **需要你处理的：0 处。** 这个库现在没有烂掉的地方。");
  } else {
    lines.push(`- **需要你处理的：${String(report.actionable.length)} 处**（error ${String(errors)} · warn ${String(warns)}）。`);
  }
  lines.push(
    report.informational.length === 0
      ? "- 仅作参考：0 处。"
      : `- 仅作参考：${String(report.informational.length)} 处（孤儿之类——它们不影响使用，只是没人碰过）。`,
  );
  if (report.unchecked.length === 0) {
    lines.push("- 本次没查的：无（该查的都查了）。");
  } else {
    lines.push("- 本次**没查**的（这不是「查过了，没问题」）：");
    for (const item of report.unchecked) lines.push(`  - ${item}`);
  }
  lines.push("");

  // ── 先做哪三件 ─────────────────────────────────────────────────────────
  const top = report.actionable.slice(0, 3);
  if (top.length > 0) {
    lines.push("## 先做这三件");
    lines.push("");
    for (const [index, finding] of top.entries()) {
      lines.push(`${String(index + 1)}. \`${finding.code}\` ${finding.path}`);
      lines.push(`   ${finding.message}`);
      lines.push(`   → ${finding.fix}`);
    }
    if (report.actionable.length > top.length) {
      lines.push("");
      lines.push(`> 另有 ${String(report.actionable.length - top.length)} 处在下面的清单里。`);
    }
    lines.push("");
  }

  // ── 规模：它是刻度，不是分数 ────────────────────────────────────────────
  lines.push("## 规模");
  lines.push("");
  lines.push("| 类型 | 条数 |");
  lines.push("|---|---|");
  for (const type of ASSET_TYPES) lines.push(`| ${type} | ${String(report.byType[type])} |`);
  lines.push(`| **合计** | **${String(report.total)}** |`);
  lines.push("");
  lines.push(
    `> 参考线：家酿的知识库普遍在 ${String(DRIFT_SCALE.from)}–${String(DRIFT_SCALE.to)} 条事实之后开始漂移。` +
      `这不是阈值，也没有任何检查挂在它上面——**条数到了不是问题，到了之后还看得见问题才是**。`,
  );
  lines.push("");

  // ── 到期未确认 ─────────────────────────────────────────────────────────
  lines.push("## 到期未确认的状态");
  lines.push("");
  if (report.due.length === 0) {
    lines.push("（没有。expired 的判据来自分类法的 `confirm_within_days`。）");
  } else {
    lines.push(`${String(report.due.length)} 条超过了窗口。**最旧的先处理**——先把它们按这个顺序问一遍：`);
    lines.push("");
    for (const item of report.due.slice(0, REPORT_DETAIL_LIMIT)) {
      lines.push(`- \`${item.path}\` —— 已 ${String(item.ageDays)} 天没确认（窗口 ${String(item.windowDays)} 天）`);
    }
    if (report.due.length > REPORT_DETAIL_LIMIT) {
      lines.push("");
      lines.push(`> 以上为最旧的 ${String(REPORT_DETAIL_LIMIT)} 条；共 ${String(report.due.length)} 条。`);
    }
    lines.push("");
    lines.push(
      "确认它的命令：`forge confirm <资产 ID> --date <今天> --note <为什么它仍然成立>`。" +
        "**这一步只能由人做**：机器自动刷新会让「过期」这件事永远不被看见（ADR-0036）。",
    );
  }
  lines.push("");

  // ── 逐类清单（需要动手的）──────────────────────────────────────────────
  writeFindings(lines, "需要处理的", report.actionable);
  writeFindings(lines, "仅供参考", report.informational);

  return lines.join("\n");
}

/**
 * 周报（S28）—— "为什么值得订阅"的那份东西。
 *
 * 它与健康报告的分工：健康报告回答"库现在什么样"，周报回答
 * **"这一周它变成了什么样，以及有没有发生变化"**。
 * 所以周报的骨架是**差异**，不是清单：
 *
 * | 一节 | 它的数据从哪来 | 它回答的问题 |
 * |---|---|---|
 * | 本周动过什么 | 审计日志（S27） | 这一周谁改了库 |
 * | 本周的库 | 健康报告（S25） | 现在有多少条、有多少条过期 |
 * | 需要你回答的问题 | 到期清单（S26） | 今天该确认哪几条 |
 *
 * **没有数据就说没有数据**：没有审计日志时，这一节写"审计里没有这一周的记录"，
 * 而不是把"没记录"渲染成"这周什么都没发生"——这两句话不一样，
 * 而后者会让一个人以为自己的库很安静。
 *
 * @param {{report: HealthReport; audit: AuditEntry[] | null; weekStart: string; weekEnd: string; title?: string}} input
 * @returns {string}
 */
export function renderWeeklyReport(input: {
  report: HealthReport;
  /** 窗口内的审计条目。`null` = **没有审计**（不是"这周没动过"）。 */
  audit: AuditEntry[] | null;
  /** `YYYY-MM-DD`，含首尾。 */
  weekStart: string;
  weekEnd: string;
  title?: string;
}): string {
  const title = input.title ?? "资产库";
  const lines: string[] = [];

  lines.push(`# ${title} · 周报（${input.weekStart} → ${input.weekEnd}）`);
  lines.push("");
  lines.push("> 由 `forge weekly --today <日期>` 生成。窗口与基准日都是**输入**，");
  lines.push("> 所以同一周的周报可以重印，字节相同（R6）。");
  lines.push("");

  lines.push("## 这一周库变成了什么样");
  lines.push("");
  const errors = input.report.actionable.filter((finding) => finding.severity === "error").length;
  lines.push(`- 资产合计 **${String(input.report.total)}** 条。`);
  lines.push(
    `- 需要你处理的：**${String(input.report.actionable.length)} 处**（error ${String(errors)} · warn ${String(input.report.actionable.length - errors)}）。`,
  );
  lines.push(`- 到期未确认的状态：**${String(input.report.due.length)}** 条。`);
  if (input.report.actionable.length === 0 && input.report.due.length === 0) {
    lines.push("- **没有需要你动手的事。** 这不是一句恭维，它是一条读数。");
  }
  if (input.report.unchecked.length > 0) {
    lines.push(`- 本次没查的：${input.report.unchecked.join("；")}。`);
  }
  lines.push("");

  lines.push("## 这一周谁动了库");
  lines.push("");
  if (input.audit === null) {
    // 关键的一句：**没有日志 ≠ 什么都没发生**。把它渲染成后者，
    // 就等于用一份空报告替一份缺失的账本背书。
    lines.push("审计里没有这一周的记录——**这不等于这一周什么都没发生**。");
    lines.push("");
    lines.push("> 只有经过 forge 的写入才会进审计（`forge promote` / `conflicts --resolve` / `confirm`）。");
    lines.push("> 直接往 `assets/` 里放文件、或者在别处编辑，审计看不到——那是文件系统的性质。");
    lines.push("> 健康检查里的 `AUDIT_UNATTRIBUTED_ASSET` 就是用来让这种沉默的写入变得可见的。");
  } else if (input.audit.length === 0) {
    lines.push("审计里这一周有记录，但没有任何一条落在这个窗口里：**这一周确实没有过写入**。");
  } else {
    const byKind = new Map<string, number>();
    for (const entry of input.audit) byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
    lines.push(`共 ${String(input.audit.length)} 条记录（链已核对，见下）：`);
    lines.push("");
    for (const kind of Object.values(AUDIT_KINDS)) {
      const count = byKind.get(kind) ?? 0;
      if (count === 0) continue;
      lines.push(`- ${kind}：${String(count)} 条`);
    }
    lines.push("");
    lines.push("链条明细（谁、什么时候、动了什么）：");
    lines.push("");
    for (const entry of input.audit.slice(-REPORT_DETAIL_LIMIT)) {
      lines.push(`- \`${entry.at}\` **${entry.actor}** ${entry.kind} \`${entry.subject}\``);
      for (const [key, value] of Object.entries(entry.detail).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        lines.push(`  - ${key}：${value}`);
      }
    }
    if (input.audit.length > REPORT_DETAIL_LIMIT) {
      lines.push("");
      lines.push(`> 以上为最近 ${String(REPORT_DETAIL_LIMIT)} 条；窗口内共 ${String(input.audit.length)} 条。`);
    }
  }
  lines.push("");

  lines.push("## 需要你回答的问题");
  lines.push("");
  if (input.report.due.length === 0 && input.report.actionable.length === 0) {
    lines.push("（没有。下一周再来。）");
  } else {
    for (const item of input.report.due.slice(0, 5)) {
      lines.push(
        `- 状态 \`${item.path}\` 已 ${String(item.ageDays)} 天没确认，**它仍然成立吗？**` +
          `（成立就 \`forge confirm\`，不成立就走一次状态替换）`,
      );
    }
    for (const finding of input.report.actionable.slice(0, 5)) {
      lines.push(`- \`${finding.code}\`：${finding.path} —— ${finding.fix}`);
    }
    if (input.report.due.length > 5 || input.report.actionable.length > 5) {
      lines.push("");
      lines.push("> 上面各取前 5 条；完整清单在 `forge health` 里。");
    }
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * @param {string[]} lines
 * @param {string} heading
 * @param {HealthFinding[]} findings
 * @returns {void}
 */
function writeFindings(lines: string[], heading: string, findings: HealthFinding[]): void {
  if (findings.length === 0) return;
  lines.push(`## ${heading}（${String(findings.length)} 处）`);
  lines.push("");
  for (const finding of findings.slice(0, REPORT_DETAIL_LIMIT)) {
    lines.push(`### \`${finding.code}\` · ${finding.path}`);
    lines.push("");
    lines.push(finding.message);
    lines.push("");
    lines.push(`→ ${finding.fix}`);
    lines.push("");
  }
  if (findings.length > REPORT_DETAIL_LIMIT) {
    lines.push(`> 以上 ${String(REPORT_DETAIL_LIMIT)} 条；共 ${String(findings.length)} 处。其余同类，修法相同。`);
    lines.push("");
  }
}
