/**
 * v0 → v1 迁移（ADR-0008：通道先建，而且**现在就用**）。
 *
 * 第一批被迁移的不是假数据，是仓库里那 5 条写在 schema 之前的 ADR。
 * 它们**缺 `schema_version`**（ADR-0008：缺版本号 = v0），
 * 而且 `sources` 是 v0 的自由写法（`implement2.md#Phase 0 · S3`）。
 *
 * **这个迁移刻意只做机械的部分。** 它把能确定性转换的转掉，
 * 把转不了的**原样保留并写下 note**——因为"转不了"的真实含义是
 * "需要一个知道那份文档的人来判断"，而迁移脚本不是那个人。
 * 猜一个大概的位置写进去，比留着让它报红更糟：它会让一条**假出处**看起来像真的。
 *
 * 这不是权宜之计，而是 ADR-0009 origin_incident 那条教训的直接产物：
 * 那 5 条 ADR 当初**是**带出处的，但出处是自由文本，"有出处"就退化成了
 * "有一段看起来像出处的文字"。迁移如果也这么干，就是把这个错误再犯一遍。
 */

/** v0 里可能出现的仓库顶层目录：这些路径前面**不**加 `docs/`。 */
const REPO_TOP_LEVEL = new Set(["docs", "scripts", "packages", "apps", "schema", "evals", "data"]);

/** `#t:` 片段的最小长度，与 packages/core 的 MIN_TEXT_ANCHOR_LENGTH 一致。 */
const MIN_TEXT_ANCHOR_LENGTH = 8;

export interface MigrationOutcome {
  text: string;
  /** 转不了、需要人处理的地方。**空的 notes 才代表"机械部分全部完成"。** */
  notes: string[];
}

export interface MigrationStep {
  from: number;
  to: number;
  description: string;
  migrate(text: string): MigrationOutcome;
}

/**
 * @param {number} from
 * @param {number} to
 * @returns {MigrationStep[]}
 */
export function planMigration(from: number, to: number): MigrationStep[] {
  if (from === to) return [];
  if (to < from) {
    throw new Error(`不能往低版本迁移：${from} → ${to}（回退是另一件事，需要显式的"降级"决策）`);
  }

  const steps: MigrationStep[] = [];
  let cursor = from;
  while (cursor < to) {
    const step = MIGRATIONS.find((candidate) => candidate.from === cursor);
    if (step === undefined) {
      // 区间缺口必须明确报错，**不许"尽力而为地跳过去"**（ADR-0008）：
      // 跳过一段迁移意味着中间那次格式变更被静默忽略，而静默忽略的错误
      // 只会在数据已经变形之后才被发现。
      throw new Error(`迁移区间缺口：没有 v${cursor} → v${cursor + 1} 的迁移步骤。补上它，或者明确说明为什么不需要。`);
    }
    steps.push(step);
    cursor = step.to;
  }
  return steps;
}

/**
 * 把一段资产文本从它自己的版本迁到目标版本。
 *
 * @param {string} text
 * @param {number} from
 * @param {number} target
 * @returns {MigrationOutcome}
 */
export function migrateAssetText(text: string, from: number, target: number): MigrationOutcome {
  let current = text;
  const notes: string[] = [];
  for (const step of planMigration(from, target)) {
    const outcome = step.migrate(current);
    current = outcome.text;
    notes.push(...outcome.notes);
  }
  return { text: current, notes };
}

/** 迁移表。**每个区间一个纯变换**，没有"从哪迁到哪"的外部状态。 */
export const MIGRATIONS: readonly MigrationStep[] = [
  {
    from: 0,
    to: 1,
    description: "补 schema_version；v0 的出处写法（相对路径 + 自由锚点）转成 file:// span",
    migrate: migrateV0ToV1,
  },
];

/**
 * @param {string} text
 * @returns {MigrationOutcome}
 */
export function migrateV0ToV1(text: string): MigrationOutcome {
  const notes: string[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  if (lines[0] !== "---") {
    return { text, notes: ["找不到 front-matter：这份文件不是资产，或者已经被别的工具改写过了"] };
  }
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closeIndex < 0) {
    return { text, notes: ["front-matter 没有结束行，无法迁移"] };
  }

  const head = lines.slice(0, closeIndex + 1);
  const tail = lines.slice(closeIndex + 1);

  if (head.some((line) => line.startsWith("schema_version:"))) {
    // 已经是 v1 了。迁移**必须幂等**：重复跑一次不该产生第二份 `schema_version`。
    return { text, notes: [] };
  }

  const out: string[] = ["---", "schema_version: 1"];
  let inSources = false;

  for (const line of head.slice(1)) {
    if (line.startsWith("sources:")) {
      inSources = true;
      out.push(line);
      continue;
    }
    if (inSources && /^\s*-\s/.test(line)) {
      out.push(convertSourceLine(line, notes));
      continue;
    }
    if (inSources && line.trim().length > 0 && !/^\s/.test(line)) {
      inSources = false;
    }
    if (line.startsWith("origin_incident:")) {
      out.push(convertIncidentLine(line, notes));
      continue;
    }
    out.push(line);
  }

  return { text: [...out, ...tail].join("\n"), notes };
}

/**
 * `  - "implement2.md#Phase 0 · S3"` → `  - "file://docs/implement2.md#t:Phase 0 · S3"`
 *
 * @param {string} line
 * @param {string[]} notes
 * @returns {string}
 */
function convertSourceLine(line: string, notes: string[]): string {
  const match = /^(\s*-\s*)(.*)$/.exec(line);
  const prefix = match?.[1];
  const rawValue = match?.[2];
  if (prefix === undefined || rawValue === undefined) return line;

  const { value, quoted } = unquote(rawValue.trim());
  if (value.includes("://")) return line; // 已经是 v1 形状

  const converted = convertV0Span(value);
  if (converted === null) {
    notes.push(`出处「${value}」无法机械转换（锚点太短或形状不认识），保持原样等人工重指`);
    return line;
  }
  return `${prefix}${quoted ? quote(converted) : converted}`;
}

/**
 * `origin_incident: "Phase 0 演练场景 A：……"` —— 自由文本不是 span。
 *
 * ADR-0009 要求 `origin_incident` 也是一个 span（"每条规则可追溯到一个**具体**出过的问题"）。
 * 自由文本转不成 span，所以这里**只记 note，不改值**：
 * 把它硬塞进某个 `#t:` 会让一条编造的引用看起来像证据。
 *
 * @param {string} line
 * @param {string[]} notes
 * @returns {string}
 */
function convertIncidentLine(line: string, notes: string[]): string {
  const value = line.slice("origin_incident:".length).trim();
  if (value === "null" || value.length === 0) return line;
  const { value: inner } = unquote(value);
  if (inner.includes("://")) return line;
  notes.push(`origin_incident「${inner}」是自由文本，不是 span：需要人工指到那次事故的记录上（ADR-0009）`);
  return line;
}

/**
 * v0 的出处写法 → v1 的 span。转不了返回 null。**纯字符串变换，不猜位置。**
 *
 * @param {string} value
 * @returns {string | null}
 */
export function convertV0Span(value: string): string | null {
  const hashAt = value.indexOf("#");
  const rawTarget = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const anchor = hashAt >= 0 ? value.slice(hashAt + 1) : "";

  if (rawTarget.length === 0 || /\s/.test(rawTarget)) return null;

  // v0 的路径大多相对 `docs/`，但也有直接写 `scripts/...` 的。
  // 这条规则是机械的、可解释的，不是"大概率猜对"。
  const firstSegment = rawTarget.split("/")[0] ?? "";
  const target = REPO_TOP_LEVEL.has(firstSegment) ? rawTarget : `docs/${rawTarget}`;

  if (anchor.length === 0) return `file://${target}`;

  // 行区间原样保留（`#L1-L9` 是 v0 就有的一种写法）。
  if (/^L\d+-L\d+$/.test(anchor)) return `file://${target}#${anchor}`;

  // 已经带了 anchor 种类的（`h:` / `t:` / `k:`）原样保留。
  if (/^(h|t|k):/.test(anchor)) return `file://${target}#${anchor}`;

  // 其余一律当**文本片段**：v0 的锚点写的是"那段话"，不是标题。
  if (anchor.replace(/\s+/g, " ").trim().length < MIN_TEXT_ANCHOR_LENGTH) {
    // 太短的片段哪都能命中，等于没有定位能力——不转换比转成一个假锚点好。
    return null;
  }
  return `file://${target}#t:${anchor}`;
}

/**
 * @param {string} value
 * @returns {{value: string, quoted: boolean}}
 */
function unquote(value: string): { value: string; quoted: boolean } {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return { value: value.slice(1, -1), quoted: true };
  }
  return { value, quoted: false };
}

/**
 * @param {string} value
 * @returns {string}
 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
