/**
 * 浏览器采集的**纯逻辑**（S23）—— 选择器配置、站点匹配、增量去重（零 IO、零 DOM）。
 *
 * implement2.md 对这个出口的原话是两句，两句都直接决定了这里的形状：
 *
 * > **只做"取用 + 增量采集"**，且**选择器配置可远端热更新**。
 *
 * ## 为什么"热更新"是这一块的核心，而不是一个附加功能
 *
 * 这个品类的第一大差评是"平台一改版工具就坏"（占全部评价 16%），而插件是所有来源里
 * 最脆弱的一环——它依赖 DOM，而 DOM 是私有实现细节。既然脆弱性消不掉，
 * 就把它**前移到一个能当天修好的地方**：DOM 结构改变时，要改的是**一份配置**，
 * 不是一次扩展发版（发版要过商店审核，那是几天到几周）。
 *
 * ## 一条安全性质，写在类型里而不是文档里
 *
 * 远端来的那份配置**只能表达选择器**，表达不了代码：`SelectorConfig` 里没有任何
 * 可以执行的东西，解析器也不 `eval`。所以"远端配置被投毒"的最坏后果是
 * **采不到东西**，不是"能在页面里跑任意代码"。这条边界是热更新敢做的前提——
 * 没有它，"远端可热更新"就等于"远端可以改你的浏览器"。
 *
 * ## 这条边界为什么落在这里，而不是落在 `apps/extension` 里
 *
 * 浏览器**不能**执行 TypeScript（本仓库零构建，ADR-0011 靠的是 Node 的原生类型擦除），
 * 所以扩展里那几十行 DOM 胶水没法直接 import 这个模块。于是这条线画在：
 *
 * - **判定在这里**（配置能不能用、该用哪一份、这个 URL 归谁管、一条记录的键是什么、
 *   哪些是增量）——它们全都能被 `node --test` 跑；
 * - **DOM 胶水在扩展里**（`querySelectorAll` 取值、读浏览器的时钟把相对时间折成 ISO）——
 *   它们的形状是 "读不到就返回 null"，没有可判定的东西可写错；
 * - **R5 的执行体**：扩展里没有任何"到底算不算"的判断。它把采到的东西报给
 *   `forge serve`，由**这份代码**去键、去重、去落 sources。
 */
import { contentAddressedId } from "@forge/schema";

/** 配置格式的版本。它跟着**字段形状**走，不跟资产 schema 走。 */
export const SELECTOR_CONFIG_VERSION = 1;

/** 一个字段的选择器。全部相对"一条记录"这个元素。 */
export interface FieldSelectors {
  /** 稳定定位键（消息 id / 时间戳 / 序号）。没有它就只能靠内容哈希。 */
  key?: string;
  /** 正文。**必填**：没有正文的记录没有采集价值。 */
  text: string;
  author?: string;
  time?: string;
}

/** 一个站点的选择器。 */
export interface HostSelectors {
  /**
   * URL 前缀。用**前缀**而不是正则：前缀是可复核的（"这个地址归它管"），
   * 而一条正则能在人看不出问题的情况下匹配到另一个站点。
   */
  match: string;
  /** 人读的站点名，进报告与日志。 */
  label: string;
  /** 列表容器（可以省略：省略时从 `document` 开始找）。 */
  list?: string;
  /** 一条记录的容器。 */
  item: string;
  fields: FieldSelectors;
}

export interface SelectorConfig {
  config_version: number;
  /**
   * 版本号，**只能增**。它是热更新的比较键：
   * 大的赢；相同则**远端赢**（远端是活的那一份，本地的只是随包发的兜底）。
   */
  revision: number;
  /** `YYYY-MM-DD`。只用于显示"这份配置是什么时候的"。 */
  updated_at: string;
  hosts: HostSelectors[];
}

/** 解析结果。失败时给**逐条**的问题，而不是一句"格式不对"。 */
export type ParseConfigResult = { ok: true; value: SelectorConfig } | { ok: false; issues: string[] };

/**
 * 解析一份选择器配置。**只认自己认识的东西**，多余字段直接忽略（前向兼容），
 * 但类型错、必填缺失一律拒绝——一份"看起来能跑"的坏配置会在采集时
 * 静静地采到空内容，而空内容与"这个站点没有新东西"看起来一模一样。
 *
 * @param {unknown} raw
 * @returns {ParseConfigResult}
 */
export function parseSelectorConfig(raw: unknown): ParseConfigResult {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ["配置必须是一个对象"] };
  }
  const record = raw as Record<string, unknown>;

  const configVersion = record["config_version"];
  if (typeof configVersion !== "number" || !Number.isSafeInteger(configVersion)) {
    issues.push("config_version 必须是整数");
  } else if (configVersion !== SELECTOR_CONFIG_VERSION) {
    issues.push(
      `config_version = ${String(configVersion)}，只认识 ${String(SELECTOR_CONFIG_VERSION)}——` +
        `不认识的版本**不猜**：猜错的表现是采到空内容，而不是报错`,
    );
  }

  const revision = record["revision"];
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    issues.push("revision 必须是非负整数（它是热更新的比较键）");
  }

  const updatedAt = record["updated_at"];
  if (typeof updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) {
    issues.push("updated_at 必须是 YYYY-MM-DD");
  }

  const hostsRaw = record["hosts"];
  const hosts: HostSelectors[] = [];
  if (!Array.isArray(hostsRaw)) {
    issues.push("hosts 必须是数组");
  } else {
    hostsRaw.forEach((entry, index) => {
      const parsed = parseHostSelectors(entry, index);
      if (typeof parsed === "string") issues.push(parsed);
      else hosts.push(parsed);
    });
    if (hosts.length === 0 && hostsRaw.length === 0) issues.push("hosts 是空的：没有任何站点能被采集");
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      config_version: SELECTOR_CONFIG_VERSION,
      revision: revision as number,
      updated_at: updatedAt as string,
      hosts,
    },
  };
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @returns {HostSelectors | string}
 */
function parseHostSelectors(entry: unknown, index: number): HostSelectors | string {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return `hosts[${String(index)}] 不是对象`;
  }
  const record = entry as Record<string, unknown>;
  const at = `hosts[${String(index)}]`;

  const match = record["match"];
  if (typeof match !== "string" || match.length === 0) return `${at}.match 必须是非空字符串`;
  const label = record["label"];
  if (typeof label !== "string" || label.length === 0) return `${at}.label 必须是非空字符串`;
  const item = record["item"];
  if (typeof item !== "string" || item.length === 0) return `${at}.item 必须是非空字符串`;

  const list = record["list"];
  if (list !== undefined && typeof list !== "string") return `${at}.list 必须是字符串`;

  const fields = record["fields"];
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return `${at}.fields 必须是对象`;
  const fieldRecord = fields as Record<string, unknown>;
  const text = fieldRecord["text"];
  if (typeof text !== "string" || text.length === 0) return `${at}.fields.text 必须是非空字符串（没有正文就没有采集价值）`;

  const out: HostSelectors = {
    match,
    label,
    item,
    fields: { text },
  };
  if (typeof list === "string") out.list = list;
  for (const key of ["key", "author", "time"] as const) {
    const value = fieldRecord[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return `${at}.fields.${key} 必须是字符串`;
    out.fields[key] = value;
  }
  return out;
}

/**
 * 为某个 URL 挑一组选择器。**最长前缀赢**，同长度时按 `match` 字典序
 * （确定性：不依赖配置里的先后顺序，那会让"谁在前"变成一个隐藏的优先级）。
 *
 * @param {SelectorConfig} config
 * @param {string} url
 * @returns {HostSelectors | null}
 */
export function hostForUrl(config: SelectorConfig, url: string): HostSelectors | null {
  const candidates = config.hosts
    .filter((host) => url.startsWith(host.match))
    .sort((a, b) => (a.match.length !== b.match.length ? b.match.length - a.match.length : a.match < b.match ? -1 : 1));
  return candidates[0] ?? null;
}

export interface ChooseResult {
  config: SelectorConfig;
  source: "remote" | "bundled";
  /** 为什么是这一份。它进日志——热更新的"生效了吗"必须能被回答。 */
  why: string;
}

/**
 * 挑用哪一份配置：**revision 大的赢，相同则远端赢**。
 *
 * 为什么相同也让远端赢：本地的只是"随包发的兜底"，而远端那一份是活的——
 * 平台改版之后修的是它。反过来（本地赢）会让一次扩展更新把热更新的成果**倒退**回去，
 * 而倒退是无声的：选择器还在，采到的东西变少了。
 *
 * 远端**解析不动**时退回本地，并把原因写进 `why`：
 * 一份坏配置不该让采集整个停摆，但它必须被看见。
 *
 * @param {SelectorConfig} bundled
 * @param {unknown} remote
 * @returns {ChooseResult}
 */
export function chooseSelectorConfig(bundled: SelectorConfig, remote: unknown): ChooseResult {
  if (remote === null || remote === undefined) {
    return { config: bundled, source: "bundled", why: "远端没有配置（拿不到 / 没配过）：用随包的那一份" };
  }
  const parsed = parseSelectorConfig(remote);
  if (!parsed.ok) {
    return {
      config: bundled,
      source: "bundled",
      why: `远端的配置解析不动，退回随包的那一份：${parsed.issues.join("；")}`,
    };
  }
  if (parsed.value.revision < bundled.revision) {
    return {
      config: bundled,
      source: "bundled",
      why:
        `随包的那一份更新（revision ${String(bundled.revision)} > 远端 ${String(parsed.value.revision)}）：` +
        `用本地，免得一次扩展更新把远端的热修倒退回去`,
    };
  }
  return {
    config: parsed.value,
    source: "remote",
    why: `远端的 revision ${String(parsed.value.revision)} ≥ 本地 ${String(bundled.revision)}：用远端那一份（它是活的）`,
  };
}

/**
 * 一条采到的记录。它是**证据的原料**，不是断言。
 *
 * 它**不带站点**：站点在载荷上写一次（`host`）。每条都带一份的结局是
 * "同一份载荷里出现了两个站点"，而那时没有东西能说清哪一个是它真正的来源。
 */
export interface CapturedItem {
  /** 内容寻址的键（由 `captureKeyOf` 派生）。 */
  key: string;
  text: string;
  author: string | null;
  time: string | null;
}

/**
 * 热更新的**决定**，形状与 `chooseSelectorConfig` 不同：调用方**手里没有**兜底配置。
 *
 * 这个形状是为浏览器准备的：扩展持有本地的兜底配置与一份缓存，而桥持有远端那一份。
 * 让桥回一个"用谁"的结论，扩展就只需要 `if (decision.use === "remote")`——
 * **比较逻辑留在能被测的这一侧**，浏览器里那几十行胶水不需要判断"哪个更新"。
 *
 * @param {number} haveRevision 调用方手里那份的 revision
 * @param {unknown} remote 远端配置（拿不到时是 null / undefined）
 * @returns {{use: "remote", config: SelectorConfig, why: string} | {use: "local", why: string}}
 */
export function decideSelectorRevision(
  haveRevision: number,
  remote: unknown,
): { use: "remote"; config: SelectorConfig; why: string } | { use: "local"; why: string } {
  if (remote === null || remote === undefined) {
    return { use: "local", why: "远端没有配置（拿不到 / 没配过）：用你手里那一份" };
  }
  const parsed = parseSelectorConfig(remote);
  if (!parsed.ok) {
    return { use: "local", why: `远端的配置解析不动，用你手里那一份：${parsed.issues.join("；")}` };
  }
  if (parsed.value.revision < haveRevision) {
    return {
      use: "local",
      why:
        `你手里那一份更新（revision ${String(haveRevision)} > 远端 ${String(parsed.value.revision)}）：` +
        `免得一次扩展更新把远端的热修倒退回去`,
    };
  }
  return {
    use: "remote",
    config: parsed.value,
    why: `远端的 revision ${String(parsed.value.revision)} ≥ 你手里那份 ${String(haveRevision)}：用远端（它是活的）`,
  };
}

/**
 * 一条记录的键。
 *
 * 优先用页面给出的稳定键（消息 id 之类），没有就用**内容寻址**：
 * 同样的站点 + 同样的正文 = 同一条记录。于是"这条我看过了"这件事
 * 不需要一个会漂移的本地数据库——重新算一遍就得到同一个键。
 *
 * 站点进种子：两个站点上的一模一样的一句话是**两条**独立的记录，
 * 合成一条会丢来源（与 `link.ts` 里"类型也进键"是同一条理由）。
 *
 * **形状是被下游约束死的**：它会变成事件 IR 的 `key`，而 key 的形状是
 * `<段>(/<段>)*`、段里不许有空白与反斜杠（`KEY_PATTERN`）。
 * 所以这里不拼人读的文字，而是拼 `站点/内容哈希`——
 * 人读的那一份由 `text` 与 `author` 承担，键只要**稳定且可定位**。
 *
 * @param {{host: string, rawKey: string | null, text: string}} item
 * @returns {string}
 */
export function captureKeyOf(item: { host: string; rawKey: string | null; text: string }): string {
  const seed =
    item.rawKey === null || item.rawKey.length === 0 ? `text:${normalizeText(item.text)}` : `key:${item.rawKey}`;
  return `${hostSlugOf(item.host)}/${contentAddressedId("", `${item.host}\n${seed}`)}`;
}

/**
 * 站点标识 → 一个能进键的段。
 *
 * 折叠规则是**确定性的**（不依赖 locale，与 `emit.ts` 的 `slugify` 同一条理由）：
 * 保留字母数字，其余折成 `-`。空结果有兜底——一个空段会让键的形状非法，
 * 而非法键会在**编译**的时候才炸，离这里很远。
 *
 * @param {string} host
 * @returns {string}
 */
export function hostSlugOf(host: string): string {
  const folded = host.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
  return folded.length > 0 ? folded.slice(0, 40) : "host";
}

/**
 * 增量：**只留下没见过的**。
 *
 * 这是"增量采集"的全部实现，也是它敢做成增量的理由——
 * 判据是**内容寻址的键**，不是"上次采到几点"的时间戳：
 * 时间戳会漏（编辑过的旧消息），内容哈希不会。
 *
 * @param {CapturedItem[]} items
 * @param {Iterable<string>} seen 已经采过的键
 * @returns {{fresh: CapturedItem[]; duplicates: number}}
 */
export function freshItems(items: CapturedItem[], seen: Iterable<string>): { fresh: CapturedItem[]; duplicates: number } {
  const known = new Set(seen);
  const fresh: CapturedItem[] = [];
  let duplicates = 0;
  for (const item of items) {
    if (known.has(item.key)) {
      duplicates += 1;
      continue;
    }
    // 本次之内的重复也算重复：同一条消息在一个页面上出现两次是常见的。
    known.add(item.key);
    fresh.push(item);
  }
  return { fresh, duplicates };
}

/** 一次采集的载荷。它的形状由 `@forge/ingest` 的 `web-capture` 连接器解析。 */
export interface CapturePayload {
  capture_version: number;
  /** 站点标识（`match`）。 */
  host: string;
  /** 人读的站点名。 */
  label: string;
  /** 采集发生的页面地址。**不是时间戳**：地址是证据的一部分，时间会被下游从消息自身推。 */
  page: string;
  items: Array<{ key: string; text: string; author: string | null; time: string | null }>;
}

/** 载荷格式的版本。与选择器配置的版本分开：两者演进的理由不同。 */
export const CAPTURE_PAYLOAD_VERSION = 1;

/**
 * 把增量打包成一份载荷。
 *
 * **空载荷不产生**（返回 null）：一次"什么都没采到"的上报会在 sources 层
 * 留下一份空来源，而空来源与"这个站点没有新东西"在下游看起来一模一样。
 * 采集失败要走上报（`skipped`），不是走这里。
 *
 * @param {{host: string, label: string, page: string, items: CapturedItem[]}} input
 * @returns {CapturePayload | null}
 */
export function buildCapturePayload(input: {
  host: string;
  label: string;
  page: string;
  items: CapturedItem[];
}): CapturePayload | null {
  const items = [...input.items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (items.length === 0) return null;
  return {
    capture_version: CAPTURE_PAYLOAD_VERSION,
    // 站点标识单独一个字段，**不混进 items 里**：界面上要显示"这是从哪个站点采的"。
    host: input.host,
    label: input.label,
    page: input.page,
    // 键排序（R6）：同一批记录无论以什么顺序采到，写进 sources 的都是同一份字节。
    items: items.map((item) => ({ key: item.key, text: item.text, author: item.author, time: item.time })),
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").split(/\s+/).filter((piece) => piece.length > 0).join(" ");
}
