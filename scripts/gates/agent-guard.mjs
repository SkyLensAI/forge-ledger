#!/usr/bin/env node
// @ts-check
/**
 * 闸门 1 · agent hook（PreToolUse）
 *
 * 契约（Claude Code / Agent SDK hooks）：
 *   - 工具调用前，宿主把 `{tool_name, tool_input, cwd, ...}` 以 JSON 从 stdin 传入
 *   - exit 2 = 阻断这次调用，stderr 作为理由回传给模型
 *   - exit 0 = 不做判断，交回正常权限流程
 *
 * 为什么闸门 1 必须是 hook 而不是提示词：礼貌指令会被跳过，
 * hook 是确定性的。但 hook 也会被绕过（见 docs/gates/bypass-matrix.md），
 * 所以它只是第一层，权威在 CI（闸门 3）。
 *
 * 逃生舱：FORGE_GATE_OVERRIDE="理由" —— 由人显式设置；agent 自己设置它
 * 等于绕过闸门，属于违宪行为，CI 侧仍会拦（受保护路径需要 ADR）。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { evaluateBashCommand, normalizePath, protectedReason } from "./lib/policy.mjs";

const EXIT_BLOCK = 2;

/**
 * @param {string} absPath
 * @param {string} root
 * @returns {string[]}
 */
function candidatePaths(absPath, root) {
  const normalized = normalizePath(absPath);
  /** @type {string[]} */
  const candidates = [];
  const rel = relative(root, absPath);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    candidates.push(normalizePath(rel));
  }
  candidates.push(normalized);
  // 绝对路径也保留"路径尾部"判定：跨盘符 / 符号链接时 relative 会失效。
  candidates.push(normalized.replace(/^.*?\/(?=(schema|packages|scripts|\.claude|\.githooks|\.github)\/)/, ""));
  return candidates;
}

/**
 * @returns {number}
 */
function main() {
  /** @type {string} */
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  /** @type {any} */
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // 基础设施故障（宿主没给 JSON）不应该卡住整个会话：fail-open，但留痕。
    process.stderr.write("[gate1] 无法解析 hook 输入，本次跳过检查（见 bypass-matrix：fail-open）\n");
    return 0;
  }

  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : "";
  const input = payload?.tool_input ?? {};
  const root = typeof payload?.cwd === "string" ? payload.cwd : process.cwd();

  /** @type {import("./lib/policy.mjs").Violation[]} */
  const violations = [];

  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) continue;
    for (const candidate of candidatePaths(value, root)) {
      const why = protectedReason(candidate);
      if (why !== null) {
        violations.push({
          code: "A1_PROTECTED_PATH",
          path: candidate,
          message: `受保护路径（${why}）。改这里等于改宪法或改闸门本身。`,
          fix:
            "如果是正当变更：先写 docs/adr/NNNN-*.md 记录决策，再由人执行该改动；" +
            "临时放行需人显式设置 FORGE_GATE_OVERRIDE",
        });
        break;
      }
    }
  }

  if (toolName === "Bash" && typeof input.command === "string") {
    violations.push(...evaluateBashCommand(input.command));
  }

  if (violations.length === 0) return 0;

  const override = process.env.FORGE_GATE_OVERRIDE;
  if (typeof override === "string" && override.trim().length > 0) {
    process.stderr.write(
      `[gate1] ⚠ 闸门 1 被 FORGE_GATE_OVERRIDE 放行（${override.trim()}）：` +
        `${violations.map((v) => v.code).join(", ")}\n`,
    );
    return 0;
  }

  process.stderr.write(
    [
      "",
      `✗ 闸门 1（agent hook）拦下了这次 ${toolName} 调用：`,
      "",
      ...violations.flatMap((violation) => [
        `  [${violation.code}] ${violation.path}`,
        `      ${violation.message}`,
        `      → ${violation.fix}`,
        "",
      ]),
      "  不要绕过闸门：闸门红了要修问题。CI（闸门 3）会以同样的规则再判一次。",
      "",
    ].join("\n"),
  );
  return EXIT_BLOCK;
}

process.exit(main());
