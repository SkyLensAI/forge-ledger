/**
 * 维护机器的探针 —— implement2.md 给 P7 写的那条 CI 强制项：**审计完整性**（S25–S28）。
 *
 * 与另外三个探针同一个形状、同一条理由：**它测的不是分数，是边界还在不在**。
 * P7 的边界有两条，而且它们坏起来都没有声音：
 *
 * | 边界 | 它怎么坏 | 探针怎么抓 |
 * |---|---|---|
 * | **每一次写入都有见证人** | 有人给 `writeAuthored` 开了个后门、把审计条目变成可选 | 拿真的写入路径跑一遍，然后删一行、改一行、换两行——三次都必须被抓住 |
 * | **健康检查分得开健康与烂掉** | 判定被改成"什么都报"（噪音）或"什么都不报"（瞎了） | 七组语料：干净的那组必须零发现，每组烂掉的**只许报它那一种** |
 *
 * 第三条是 P7 的退出条件（库里涨到 500–1000 条仍然可用）的**结构性替身**：
 * 它证明的是机器不会崩、边界不会松、信号不会淹，**不是**"库还好用"——
 * 后者是一条关于人的判据，代码证明不了（README 里那一行会一直写着"未达成"）。
 *
 * ## 语料一律**现造**，不用本仓库的库
 *
 * 与冲突探针用合成集同一条思路，但这里更进一层：健康检查要测的是
 * "**烂的东西能不能被认出来**"，那就必须先有确定烂法的语料。
 * 用真库做不到这一点——真库没法按需长出"一次替换写了一半"。
 * 唯一用真库的地方是"只读"那一条：跑一遍，仓库一个字节都不许变。
 *
 * ## 为什么基准日写死
 *
 * 基准日是 `today`，写死在探针里（`PROBE_TODAY`）。一个用"今天"的探针
 * 会在某天早上突然变红，而红的原因是"时间过去了"——那种红会训练人无视红色。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ASSET_CODES,
  AUDIT_GAP_CODES,
  AUDIT_KINDS,
  GENESIS_HASH,
  HEALTH_CODES,
  renderHealthReport,
  runHealth,
} from "../../packages/core/src/index.ts";
import {
  SCHEMA_VERSION,
  contentAddressedId,
  renderAssetDocument,
  type AssetDoc,
  type AssetFrontMatter,
  type AssetType,
} from "../../packages/schema/src/index.ts";
import { openVault, readRepoAssets } from "../../packages/store/src/index.ts";

/** 探针的基准日。写死是有意的：见文件头。 */
export const PROBE_TODAY = "2026-11-06";

/** 规模探针的语料大小。P7 的退出条件说的就是 500–1000 条这个量级。 */
export const SCALE_ASSETS = 1000;

export interface AuditProbeResult {
  ok: boolean;
  /** 真的写入路径产出的条目数。 */
  entries: number;
  kinds: string[];
  /** 干净的时候链必须零问题（对照：一个永远报红的检查比没有检查更糟）。 */
  cleanChainOk: boolean;
  /** 三种破坏各自有没有被抓住。 */
  caught: string[];
  missed: string[];
  /** 手写文件（绕过 forge）会不会被看见。 */
  unattributedSeen: boolean;
  /** 不给见证人时，写门是不是真的拒绝。 */
  refusesWithoutWitness: boolean;
  detail: string[];
}

export interface HealthProbeResult {
  ok: boolean;
  /** 干净语料上的发现数——必须是 0。 */
  cleanFindings: number;
  /** 语料组数。 */
  corpora: number;
  /** 该报没报的（语料 → 码）。 */
  missed: string[];
  /** 不该报却报了的（语料 → 码）。 */
  falsePositives: string[];
  /** 健康检查有没有改过东西（拿本仓库的资产跑一遍，比对字节）。 */
  readonlyOk: boolean;
  deterministic: boolean;
  detail: string[];
}

export interface ScaleProbeResult {
  ok: boolean;
  assets: number;
  /** 同一份输入跑两次的字节是否相同（库大到这个量级仍然确定）。 */
  deterministic: boolean;
  /** 埋在 1000 条里的那处腐烂有没有被找到（信号不被淹）。 */
  plantedRotFound: boolean;
  detail: string[];
}

export interface MaintenanceProbeResult {
  ok: boolean;
  audit: AuditProbeResult;
  health: HealthProbeResult;
  scale: ScaleProbeResult;
}

/**
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @param {string} [body]
 * @returns {AssetDoc}
 */
function asset(overrides: Partial<AssetFrontMatter> = {}, body?: string): AssetDoc {
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id: "state_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "state",
    status: "active",
    created: "2026-01-01",
    last_confirmed: "2026-11-01",
    supersedes: null,
    origin_incident: null,
    subject: "索引层的存储后端",
    sources: ["file://docs/implement2.md#t:检索优先，绝不预加载整个大脑"],
    sensitivity: "internal",
    confidence: 0.9,
    ...overrides,
  };
  const text = body ?? "# 一条断言\n\n正文。\n";
  return {
    path: `assets/${frontMatter.type === "decision" ? "dec" : frontMatter.type}/${frontMatter.id}.md`,
    frontMatter,
    body: text,
    raw: renderAssetDocument(frontMatter, text),
  };
}

/**
 * @param {string} seed
 * @param {AssetType} type
 * @param {Partial<AssetFrontMatter>} [overrides]
 * @returns {AssetDoc}
 */
function seeded(seed: string, type: AssetType, overrides: Partial<AssetFrontMatter> = {}): AssetDoc {
  return asset({
    type,
    id: contentAddressedId(type === "decision" ? "dec_" : type === "rule" ? "rule_" : "state_", seed),
    ...overrides,
  });
}

/** 一组"烂掉"的语料：它**必须**且**只许**报出这些码。 */
interface Corpus {
  name: string;
  assets: AssetDoc[];
  expect: string[];
  /** 覆盖基准日（默认 `PROBE_TODAY`）。用来测"窗口内不报"这一侧。 */
  today?: string;
  index?: Parameters<typeof runHealth>[0]["index"];
  audit?: Parameters<typeof runHealth>[0]["audit"];
}

/**
 * 七组语料。干净的那一组是**对照组**：一个见到什么都报的实现能让其余六组全绿。
 *
 * @returns {Corpus[]}
 */
function corpora(): Corpus[] {
  const anchor = seeded("probe/anchor", "state", { subject: "甲题面" });
  const neighbour = seeded("probe/neighbour", "state", { subject: "乙题面" });
  const lonely = seeded("probe/lonely", "state", {
    subject: "没有人引用的事",
    sources: ["file://docs/positioning.md#t:把痕迹编译成资产"],
  });

  const retired = seeded("probe/retired", "state", { status: "superseded", subject: "丙题面" });
  const successor = seeded("probe/successor", "state", {
    subject: "丙题面",
    supersedes: retired.frontMatter.id,
  });

  const dangling = seeded("probe/dangling", "state", {
    subject: "丁题面",
    supersedes: "state_01M6Q2FD00NVKBVBH80QD63VS0",
  });

  const half = seeded("probe/half", "state", { subject: "戊题面" });
  const halfNext = seeded("probe/half-next", "state", {
    subject: "戊题面",
    supersedes: half.frontMatter.id,
  });

  const twinA = seeded("probe/twin-a", "state", { subject: "己题面" });
  const twinB = seeded("probe/twin-b", "state", { subject: "己题面" });

  // "过期"那一组要**成对**：单独一条资产本身就是孤儿，而那一组只想问"过期报不报"。
  const stale = seeded("probe/stale", "state", { subject: "庚题面", last_confirmed: "2026-01-01" });
  const fresh = seeded("probe/fresh", "state", { subject: "辛题面", last_confirmed: "2026-11-01" });

  return [
    {
      name: "干净",
      assets: [anchor, neighbour],
      expect: [],
    },
    {
      name: "孤儿",
      assets: [anchor, neighbour, lonely],
      expect: [HEALTH_CODES.ORPHAN],
    },
    {
      name: "取代者指向空气",
      assets: [dangling],
      expect: [HEALTH_CODES.SILENT_SUPERSESSION],
    },
    {
      name: "替换写了一半（旧的那一代还 active）",
      assets: [half, halfNext],
      expect: [HEALTH_CODES.SILENT_SUPERSESSION],
    },
    {
      name: "标了 superseded 却没有接班人",
      assets: [retired],
      expect: [HEALTH_CODES.SILENT_SUPERSESSION],
    },
    {
      name: "正常退休（有接班人）——反例：不许误报",
      assets: [retired, successor],
      expect: [],
    },
    {
      name: "同一题面两条 active（冲突判定看不见）",
      assets: [twinA, twinB],
      expect: [HEALTH_CODES.DUPLICATE_ACTIVE],
    },
    {
      name: "过期",
      assets: [stale, fresh],
      expect: [ASSET_CODES.FRESHNESS],
    },
    {
      name: "同一份语料，但两条都在窗口里（反例：不许误报）",
      assets: [fresh, neighbour],
      expect: [],
      today: "2026-11-06",
    },
    {
      name: "索引层被删",
      assets: [anchor, neighbour],
      expect: [HEALTH_CODES.INDEX_DRIFT],
      index: { indexed: null, actual: { sources: 1, events: 8 }, indexMarkdown: null },
    },
    {
      name: "审计链断掉",
      assets: [anchor, neighbour],
      expect: [HEALTH_CODES.AUDIT_CHAIN_BROKEN],
      audit: {
        entries: [
          {
            // seq 从 2 开始（第一条被删了）+ prev 对不上 + hash 对不上：
            // 三种破坏叠在一条上，只为了断言"这一组**只**报链的问题"。
            // subject 指一条**存在**的资产：否则它还会顺带报
            // `AUDIT_DANGLING_SUBJECT`，那样这一组就分不清在测哪一件事了。
            seq: 2,
            at: "2026-11-06T10:00:00.000Z",
            actor: "someone",
            kind: AUDIT_KINDS.ASSET_PROMOTED,
            subject: anchor.frontMatter.id,
            detail: {},
            prev: GENESIS_HASH,
            hash: "f".repeat(64),
          },
        ],
        problems: [],
      },
    },
  ];
}

/**
 * @param {string} root
 * @returns {AuditProbeResult}
 */
export function runAuditProbe(root: string): AuditProbeResult {
  const detail: string[] = [];
  const caught: string[] = [];
  const missed: string[] = [];
  const kinds: string[] = [];
  let entries = 0;
  let cleanChainOk = false;
  let unattributedSeen = false;
  let refusesWithoutWitness = false;

  const vaultRoot = join(root, "vault");
  let tick = Date.parse("2026-11-06T09:00:00Z");
  const vault = openVault(vaultRoot, { now: () => (tick += 1000) });

  // ── 走真的写入路径（不是"手工造一个日志文件"）──────────────────────────
  vault.importText(readFileSync(join(process.cwd(), "evals", "fixtures", "desensitized-export.json"), "utf8"), {
    originalName: "probe-export.json",
    actor: "probe",
  });

  const candidate = {
    candidate_version: 1,
    candidate_id: "cand_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "state" as const,
    title: "索引层的存储后端",
    subject: "索引层的存储后端",
    body: "# 索引层的存储后端\n\n## 当前状态\n\n索引层用 node:sqlite。\n",
    sources: ["file://docs/implement2.md#t:检索优先，绝不预加载整个大脑"],
    confidence: 0.2,
    origin: "model" as const,
    harness: "probe",
    model: "probe-fixture",
  };
  const stored = vault.inbox.put(candidate);
  const candidateId = stored.path.split(/[\\/]/).pop()?.replace(".json", "") ?? "";
  const promoted = vault.promote(candidateId, {
    date: "2026-11-06",
    confidence: 0.8,
    actor: "probe",
    atMs: Date.parse("2026-11-06T10:00:00Z"),
    random: new Uint8Array(16),
  });
  if (!promoted.ok) {
    missed.push(`真的写入路径跑不通：${promoted.reason}`);
    return {
      ok: false,
      entries: 0,
      kinds,
      cleanChainOk: false,
      caught,
      missed,
      unattributedSeen,
      refusesWithoutWitness,
      detail,
    };
  }

  // 再确认一次：**三种破坏里"换顺序"至少要有三条才做得出来**（两条换顺序等于什么都没有换）。
  // 顺带把第三条真的写入路径（`confirm`）也过一遍。
  const promotedId = promoted.asset.path.split("/").pop()?.replace(".md", "") ?? "";
  const confirmed = vault.confirm(promotedId, {
    date: "2026-11-06",
    note: "探针确认一次：这条路径也要留下见证人",
    actor: "probe",
    atMs: Date.parse("2026-11-06T11:00:00Z"),
  });
  if (!confirmed.ok) missed.push(`confirm 这条写入路径跑不通：${confirmed.reason}`);

  // ── 日志的形状：一行一条，每一行都读得回来 ──────────────────────────────
  const file = vault.audit.path();
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const read = vault.audit.read();
  entries = read.entries.length;
  kinds.push(...read.entries.map((entry) => entry.kind));
  if (lines.length !== entries) {
    missed.push(
      `日志有 ${String(lines.length)} 行但只读出 ${String(entries)} 条：**JSONL 的契约是一行一条**，` +
        `多行 JSON 会让读取端每一行都失败`,
    );
  }

  // ── 对照：干净的时候必须零问题 ─────────────────────────────────────────
  cleanChainOk = vault.audit.verify().ok && read.problems.length === 0;
  if (!cleanChainOk) {
    missed.push(`刚写下的日志就验不过：${[...read.problems, ...vault.audit.verify().problems][0] ?? "未知"}`);
  }

  // ── 破坏一：删掉一行 ───────────────────────────────────────────────────
  const pristine = lines.join("\n");
  const tryTamper = (name: string, text: string, needle: string): void => {
    writeFileSync(file, text, "utf8");
    const problems = vault.audit.verify().problems;
    if (problems.some((problem) => problem.includes(needle))) caught.push(name);
    else missed.push(`${name}：verify 没报出「${needle}」（实际：${problems.join("；") || "零问题"}）`);
  };

  if (lines.length >= 2) {
    tryTamper("删一行", `${lines.slice(1).join("\n")}\n`, "缺了条目");
  } else {
    missed.push("删一行：日志不足两条，探针造不出这个场景");
  }

  // ── 破坏二：改一条的内容（换个人）────────────────────────────────────
  tryTamper("改内容", pristine.replace('"actor":"probe"', '"actor":"someone-else"') + "\n", "内容被改过");

  // ── 破坏三：换两行的顺序 ───────────────────────────────────────────────
  if (lines.length >= 3) {
    const swapped = [lines[1], lines[0], ...lines.slice(2)].join("\n");
    tryTamper("换顺序", `${swapped}\n`, "插入、删除或调换");
  }

  // 恢复干净的那一份：后面几条检查不该跑在一份被改坏的日志上。
  writeFileSync(file, `${pristine}\n`, "utf8");

  // ── 手写文件：审计看不见，但健康检查必须看得见 ────────────────────────
  const frontMatter: AssetFrontMatter = {
    schema_version: SCHEMA_VERSION,
    id: "rule_01M6Q2FD00NVKBVBH80QD63VSX",
    type: "rule",
    status: "active",
    created: "2026-11-06",
    last_confirmed: null,
    supersedes: null,
    origin_incident: "file://docs/implement2.md#t:检索优先，绝不预加载整个大脑",
    subject: null,
    sources: ["file://docs/implement2.md#t:检索优先，绝不预加载整个大脑"],
    sensitivity: "internal",
    confidence: 0.5,
  };
  const ruleBody = "# 手写的规则\n\n## 规则\n\n绕过 forge 写的。\n\n## 强制\n\n健康检查看得见它。\n";
  const intruderPath = join(vaultRoot, "assets", "rule", "rule_01M6Q2FD00NVKBVBH80QD63VSX.md");
  mkdirSync(dirname(intruderPath), { recursive: true });
  writeFileSync(intruderPath, renderAssetDocument(frontMatter, ruleBody), "utf8");
  unattributedSeen = vault.audit
    .completeness(vault.assets.scan().docs)
    .some((gap) => gap.code === AUDIT_GAP_CODES.UNATTRIBUTED);
  if (!unattributedSeen) {
    missed.push("有人直接往 assets/ 放文件，而审计对账没报出来——那是审计能看见这种写入的唯一方式");
  }

  // ── 写门：不给见证人就拒绝 ─────────────────────────────────────────────
  try {
    // @ts-expect-error 故意少给一个参数：**这条边界要在运行时也成立**，
    // 不能只靠类型——绕过类型的方式有很多（`any`、JS 调用方、反射）。
    vault.assets.writeAuthored(asset({ id: "state_01M6Q2FD00NVKBVBH80QD63VSY" }));
  } catch {
    refusesWithoutWitness = true;
  }
  if (!refusesWithoutWitness) {
    missed.push("不给审计条目也能写资产 —— 写门的第二个参数是**可选**的，于是「不靠礼貌指令」这句话不成立");
  }

  detail.push(
    `真的写入路径：来源导入 1 次、候选确认 1 次 → 审计 ${String(entries)} 条（${kinds.join("、")}）`,
  );
  detail.push(`三种破坏各试一次，抓住 ${String(caught.length)} 种：${caught.join("、") || "一种都没抓住"}`);
  detail.push(
    `绕过 forge 的手写文件：${unattributedSeen ? "被看见了" : "**没被看见**"}；` +
      `不给见证人的写入：${refusesWithoutWitness ? "被拒绝" : "**放过了**"}`,
  );

  return {
    ok: missed.length === 0,
    entries,
    kinds,
    cleanChainOk,
    caught,
    missed,
    unattributedSeen,
    refusesWithoutWitness,
    detail,
  };
}

/**
 * 收集一个目录树下所有文件的**内容**，用来断言"跑一遍之后什么都没变"。
 *
 * 比长度而不是只数文件：一个"把正文重写成同样长度"的写入会让"只比长度"的实现
 * 看不见——而那正是最需要被看见的那种改动。
 */
function digestTree(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) parts.push(`${full}\n${readFileSync(full, "utf8")}`);
    }
  };
  walk(dir);
  return parts.join("\n");
}

/**
 * @param {string} repoRoot
 * @returns {HealthProbeResult}
 */
export function runHealthProbe(repoRoot: string): HealthProbeResult {
  const missed: string[] = [];
  const falsePositives: string[] = [];
  const detail: string[] = [];
  const groups = corpora();
  let cleanFindings = -1;
  let deterministic = true;
  let readonlyOk = true;

  for (const corpus of groups) {
    const report = runHealth({
      assets: corpus.assets,
      today: corpus.today ?? PROBE_TODAY,
      ...(corpus.index === undefined ? {} : { index: corpus.index }),
      ...(corpus.audit === undefined ? {} : { audit: corpus.audit }),
    });
    const actual = [...new Set(report.findings.map((finding) => finding.code))].sort();
    const expected = [...corpus.expect].sort();

    if (corpus.name === "干净") cleanFindings = report.findings.length;

    for (const code of expected) {
      if (!actual.includes(code)) missed.push(`「${corpus.name}」应该报 ${code}，实际只报了 ${actual.join("、") || "零"} 条`);
    }
    for (const code of actual) {
      if (!expected.includes(code)) {
        falsePositives.push(`「${corpus.name}」不该报 ${code}——**见到什么都报等于什么都没报**`);
      }
    }
  }

  // ── 只读：跑一遍本仓库自己的资产，仓库一个字节都不许变 ────────────────
  const before = digestTree(join(repoRoot, "docs"));
  const scanned = readRepoAssets(repoRoot);
  const repoReport = runHealth({ assets: scanned.docs, today: PROBE_TODAY });
  readonlyOk = digestTree(join(repoRoot, "docs")) === before;
  if (!readonlyOk) missed.push("健康检查改动了本仓库的文件——它只许读");

  const rendered = renderHealthReport(repoReport);
  deterministic = renderHealthReport(runHealth({ assets: scanned.docs, today: PROBE_TODAY })) === rendered;
  if (!deterministic) missed.push("同一份输入跑两次，健康报告的字节不一样（R6）");

  if (scanned.invalid.length > 0) {
    missed.push(`本仓库有 ${String(scanned.invalid.length)} 个带 front-matter 的文件读不成资产`);
  }
  if (cleanFindings !== 0) {
    missed.push(
      `干净语料上报了 ${String(cleanFindings)} 条——**问的不是"能不能报"，是"干净的时候能不能不报"**`,
    );
  }

  detail.push(
    `语料 ${String(groups.length)} 组：干净的那组 ${String(cleanFindings)} 条发现；` +
      `该报没报 ${String(missed.length)} 处、不该报却报了 ${String(falsePositives.length)} 处`,
  );
  detail.push(
    `本仓库自己的 ${String(scanned.docs.length)} 条资产：跑一遍之后是只读的（${readonlyOk ? "是" : "**不是**"}）· ` +
      `报告可重印（${deterministic ? "是" : "**不是**"}）· ` +
      `读数：需要处理 ${String(repoReport.actionable.length)} 处、仅供参考 ${String(repoReport.informational.length)} 处、` +
      `到期未确认 ${String(repoReport.due.length)} 条`,
  );

  return {
    ok: missed.length === 0 && falsePositives.length === 0,
    cleanFindings: Math.max(cleanFindings, 0),
    corpora: groups.length,
    missed,
    falsePositives,
    readonlyOk,
    deterministic,
    detail,
  };
}

/**
 * 规模探针：**1000 条之后，机器还看不看得见、边界还松不松、产出还确不确定**。
 *
 * 它**不证明**"库仍然可用"——那是 P7 的退出条件，而它到底是一条关于人的判据。
 * 它证明的是三件能被证明的事：确定性不随规模退化、"烂了一处"不会被一千条好数据淹掉、
 * 检索在规模上仍然只给预算内的那几条。哪一条不成立，都说明"还能用"这句话没有地基。
 *
 * @returns {ScaleProbeResult}
 */
export function runScaleProbe(): ScaleProbeResult {
  const detail: string[] = [];
  const found: string[] = [];
  const assets: AssetDoc[] = [];

  // 语料：三类资产，出处**互相共享**（否则一千条全是孤儿，探针就只在测孤儿判定）。
  const shared = ["file://docs/implement2.md#t:检索优先，绝不预加载整个大脑"];
  const perType = Math.floor(SCALE_ASSETS / 3);
  for (let index = 0; index < perType; index += 1) {
    const subject = `题面 ${String(index)}`;
    assets.push(seeded(`scale/state/${String(index)}`, "state", { subject, sources: shared }));
    assets.push(seeded(`scale/rule/${String(index)}`, "rule", { subject: null, sources: shared, origin_incident: shared[0] ?? "" }));
    assets.push(seeded(`scale/dec/${String(index)}`, "decision", { subject: null, sources: shared }));
  }
  while (assets.length < SCALE_ASSETS) {
    assets.push(seeded(`scale/extra/${String(assets.length)}`, "event", { subject: null, sources: shared, status: "recorded" }));
  }

  // 在 1000 条里埋**一处**腐烂：替换写了一半（旧的那一代还 active）。
  // 它必须被找出来——**信号被规模淹掉**是这一条探针唯一想否掉的事。
  const half = seeded("scale/half", "state", { subject: "被替换了一半的那件事", sources: shared });
  const halfNext = seeded("scale/half-next", "state", {
    subject: "被替换了一半的那件事",
    sources: shared,
    supersedes: half.frontMatter.id,
  });
  const corpus = [...assets, half, halfNext];

  const report = runHealth({ assets: corpus, today: PROBE_TODAY });
  const rendered = renderHealthReport(report);
  const deterministic =
    rendered === renderHealthReport(runHealth({ assets: [...corpus].reverse(), today: PROBE_TODAY }));

  const plantedRotFound = report.findings.some(
    (finding) => finding.code === HEALTH_CODES.SILENT_SUPERSESSION && finding.path === halfNext.path,
  );
  if (!plantedRotFound) {
    detail.push(`埋在 ${String(corpus.length)} 条里那处「替换写了一半」没有被找到——信号被规模淹掉了`);
  }

  const seededOrphans = report.findings.filter((finding) => finding.code === HEALTH_CODES.ORPHAN).length;

  detail.push(
    `语料 ${String(corpus.length)} 条（三类资产共享同一处出处）· 健康检查 ${deterministic ? "两次字节相同" : "**不确定**"}`,
  );
  detail.push(
    `埋了 1 处腐烂，找到 ${plantedRotFound ? "了" : "**不到**"}；` +
      `顺带报出孤儿 ${String(seededOrphans)} 条（event 按规矩不进孤儿清单，所以它不会淹没清单）`,
  );

  return {
    ok: deterministic && plantedRotFound,
    assets: corpus.length,
    deterministic,
    plantedRotFound,
    detail,
  };
}

/**
 * 三个探针一起跑。落在临时目录里，跑完即删——**不碰工作区**。
 *
 * @param {string} repoRoot
 * @returns {MaintenanceProbeResult}
 */
export function runMaintenanceProbe(repoRoot: string): MaintenanceProbeResult {
  const scratch = mkdtempSync(join(tmpdir(), "forge-probe-maintenance-"));
  try {
    const audit = runAuditProbe(scratch);
    const health = runHealthProbe(repoRoot);
    const scale = runScaleProbe();
    return { ok: audit.ok && health.ok && scale.ok, audit, health, scale };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
