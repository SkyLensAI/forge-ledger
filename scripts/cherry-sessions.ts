#!/usr/bin/env node
/**
 * Cherry Studio 会话 → Forge 官方导出形状。
 *
 * 这是一个**边缘适配器**，不是判定：
 *   - 它只读 Cherry Studio 落盘的 Agent 会话转录（Claude Code JSONL）；
 *   - 只保留**人会读的对话文本**（user / assistant 的 text 块），
 *     丢掉 system prompt、thinking、tool_use / tool_result；
 *   - 输出 `official-export` 连接器认得的 JSON（`conversations[].messages[]`）。
 *
 * 为什么不让这个脚本直接写 `data/sources/`：来源层的内容寻址、连接器解析、
 * 事件规范化都是 store/ingest 的事。这里只产出一份可复核的中间文件，
 * 再由 `forge compile --import` 走**同一条**导入路径。
 *
 * 原文一字不改：只做行尾归一（与 official-export 连接器一致）。
 * 没有时间戳、没有随机数，输入相同则输出逐字节相同（R6）。
 *
 * 用法：
 *   node scripts/cherry-sessions.ts --out data/imports/cherry-sessions.json
 *   node scripts/cherry-sessions.ts --stats
 *   node scripts/cherry-sessions.ts --project forge --out ...
 *   node scripts/cherry-sessions.ts --session <转录 ID> --out ...
 *
 * --project 可以重复，按项目目录名做子串匹配（例如 `forge` 只取 D--forge-*）。
 * --session 也可以重复，按转录文件名（去掉 .jsonl）精确选择；给了 --session 时
 * 只导出这几份，并要求每一份都真实存在——拼错的 ID 必须报错，不能静默少导。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

interface Options {
  out: string | null;
  stats: boolean;
  projects: string[];
  sessions: string[];
  includeSidechains: boolean;
  root: string | null;
}

interface MessageRecord {
  id: string;
  created_at: string;
  sender: "user" | "assistant";
  text: string;
}

interface ConversationRecord {
  id: string;
  title: string;
  project: string;
  messages: MessageRecord[];
}

interface ParsedTranscript {
  records: MessageRecord[];
  unreadable: number;
}

interface TranscriptEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    out: null,
    stats: false,
    projects: [],
    sessions: [],
    includeSidechains: false,
    root: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`选项 ${flag} 缺少值`);
      index += 1;
      return next;
    };
    if (flag === "--out") options.out = value();
    else if (flag === "--stats") options.stats = true;
    else if (flag === "--project") options.projects.push(value());
    else if (flag === "--session") options.sessions.push(value());
    else if (flag === "--include-sidechains") options.includeSidechains = true;
    else if (flag === "--root") options.root = value();
    else throw new Error(`未知选项：${flag}`);
  }
  return options;
}

function defaultRoot(): string {
  const appData = process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming");
  return join(appData, "CherryStudio", "Data", "Agents", ".claude", "projects");
}

/** 只保留 text 块；数组里的 tool_result / thinking / image 一律不是"对话正文"。 */
function blocksOf(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ContentBlock => block !== null && typeof block === "object",
  );
}

function textOf(content: unknown): string {
  const pieces: string[] = [];
  for (const block of blocksOf(content)) {
    if (block.type === "text" && typeof block.text === "string") pieces.push(block.text);
  }
  return pieces.join("\n").replace(/\r\n?/g, "\n").trim();
}

function isoLike(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function readTranscript(path: string, includeSidechains: boolean): ParsedTranscript {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { records: [], unreadable: 1 };
  }

  const records: MessageRecord[] = [];
  const seen = new Set<string>();
  let unreadable = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      unreadable += 1;
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    if (entry.isSidechain === true && !includeSidechains) continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;

    const message = entry.message;
    if (message === null || typeof message !== "object") continue;
    const sender = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : null;
    if (sender === null) continue;

    const text = textOf(message.content);
    if (text.length === 0) continue;

    const createdAt = isoLike(entry.timestamp);
    if (createdAt === null) continue;

    const id = typeof entry.uuid === "string" && entry.uuid.length > 0 ? entry.uuid : null;
    if (id === null || seen.has(id)) continue;
    seen.add(id);

    records.push({ id, created_at: createdAt, sender, text });
  }

  records.sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1,
  );
  return { records, unreadable };
}

function statFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile());
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root ?? defaultRoot());

  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`找不到 Cherry Studio 的会话目录：${root}`);
  }

  const matchesProject = (name: string): boolean =>
    options.projects.length === 0 || options.projects.some((needle) => name.includes(needle));

  const projectDirs = readdirSync(root)
    .filter((name) => statSync(join(root, name)).isDirectory())
    .filter(matchesProject)
    .sort();

  const sessionIds = new Set(options.sessions);
  const selected: Array<{ project: string; file: string }> = [];
  for (const project of projectDirs) {
    for (const file of statFiles(join(root, project))) {
      const id = basename(file).replace(/\.jsonl$/, "");
      if (sessionIds.size === 0 || sessionIds.has(id)) selected.push({ project, file });
    }
  }
  if (sessionIds.size > 0) {
    const found = new Set(selected.map(({ file }) => basename(file).replace(/\.jsonl$/, "")));
    const missing = [...sessionIds].filter((id) => !found.has(id)).sort();
    if (missing.length > 0) throw new Error(`找不到会话转录：${missing.join(", ")}`);
  }

  const conversations: ConversationRecord[] = [];
  let files = 0;
  let unreadableLines = 0;
  let messages = 0;
  let bytes = 0;

  for (const { project, file } of selected) {
    files += 1;
    bytes += statSync(file).size;
    const parsed = readTranscript(file, options.includeSidechains);
    unreadableLines += parsed.unreadable;
    if (parsed.records.length === 0) continue;

    const id = basename(file).replace(/\.jsonl$/, "");
    const firstUser = parsed.records.find((record) => record.sender === "user");
    conversations.push({
      id,
      title: firstUser === undefined ? id : firstUser.text.slice(0, 80).replace(/\s+/g, " "),
      project,
      messages: parsed.records,
    });
    messages += parsed.records.length;
  }

  conversations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const summary = {
    projects: projectDirs.length,
    files,
    conversations: conversations.length,
    messages,
    unreadableLines,
    transcriptBytes: bytes,
  };

  if (options.stats || options.out === null) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!options.stats) {
      process.stderr.write("· 只统计，没有写文件：给 --out <文件> 才会导出\n");
    }
    return;
  }

  const payload = {
    generator: "forge-cherry-sessions/1",
    about: "由 Cherry Studio Agent 会话转录转换（只保留 user / assistant 的文本块）",
    conversations,
  };
  const target = resolve(options.out);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...summary, out: target }, null, 2)}\n`);
}

main();
