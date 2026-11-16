/**
 * 自动化政策与配方（docs/automation.md）。
 *
 * 这份测试钉住四件事：
 *
 * 1. **政策自身自洽**：三档都有、`prepare` 写清「人做什么」、`forbidden` 写清「强制点」；
 * 2. **生成物里没有三个「点头」动作**：这是文档承诺的核心边界，
 *    不是靠注释请求，而是扫描可执行行；
 * 3. **生成物逐字节确定**：没有时间戳、没有随机、行尾一律 LF（R6）；
 * 4. **反例真的会被抓到**：光有"检查永远绿"的实现等于没检查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TIERS,
  HUMAN_ONLY_INVOCATIONS,
  inspectAutomation,
  renderAutomationBundle,
  renderAutomationPolicy,
  validateAutomationPolicy,
  type EmittedFile,
} from "../src/index.ts";

function bundle(): EmittedFile[] {
  return renderAutomationBundle({ forgeBin: "forge", workdir: "/home/me/forge" });
}

function contentOf(files: EmittedFile[], path: string): string {
  const found = files.find((file) => file.path === path);
  assert.ok(found, `生成物里应该有 ${path}`);
  return found.content;
}

/**
 * 只看可执行行。注释里必须能解释「为什么不能自动化」，
 * 所以测试不能把整份文件当成代码来搜。
 */
function executableText(files: EmittedFile[]): string {
  return files
    .filter((file) => /\.(sh|ps1|cron|xml)$/.test(file.path))
    .flatMap((file) =>
      file.content
        .split("\n")
        .map((line) => (file.path.endsWith(".xml") ? line : line.split("#")[0] ?? "")),
    )
    .join("\n");
}

test("政策：三档都非空，id 唯一，每条都有入口与理由", () => {
  assert.deepEqual(validateAutomationPolicy(), []);
  for (const tier of AUTOMATION_TIERS) {
    assert.ok(
      AUTOMATION_ACTIONS.some((action) => action.tier === tier),
      `档位 ${tier} 一条动作都没有`,
    );
  }
  assert.ok(AUTOMATION_ACTIONS.length >= 30, "政策表不应该被悄悄删到只剩几条");
});

test("人工动作只有三个：入库、判冲突、续期", () => {
  assert.deepEqual(
    HUMAN_ONLY_INVOCATIONS.map((entry) => entry.id).sort(),
    ["candidate-promote", "conflict-resolve", "state-confirm"],
  );

  for (const human of HUMAN_ONLY_INVOCATIONS) {
    const action = AUTOMATION_ACTIONS.find((item) => item.id === human.id);
    assert.ok(action, `${human.id} 必须在政策表里`);
    assert.equal(action.tier, "prepare", `${human.id} 只能是「准备」档`);
    assert.ok(action.human && action.human.length > 0, `${human.id} 必须写清人做什么`);
    assert.ok(action.guard && action.guard.length > 0, `${human.id} 必须写清系统保险`);
  }
});

test("生成物：不含 promote / resolve / confirm，安全检查零发现", () => {
  const files = bundle();
  assert.deepEqual(inspectAutomation(files), []);

  const executable = executableText(files);
  assert.doesNotMatch(executable, /--promote\b/);
  assert.doesNotMatch(executable, /--resolve\b/);
  assert.doesNotMatch(executable, /\bconfirm\b/);
  assert.doesNotMatch(executable, /--no-verify\b/);
});

test("反例：把「点头」动作塞进脚本，检查必须报红（两侧都钉住）", () => {
  const files = bundle();
  for (const [needle, code] of [
    ["forge inbox --promote cand_1 --date 2026-11-12 --confidence 0.9", "candidate-promote"],
    ["forge conflicts --resolve cf_1 --decision replace --date 2026-11-12 --rationale x", "conflict-resolve"],
    ["forge confirm state_1 --date 2026-11-12 --note x", "state-confirm"],
  ] as const) {
    const tampered = files.map((file) =>
      file.path === "pipeline.sh" ? { ...file, content: `${file.content}\n${needle}\n` } : file,
    );
    const findings = inspectAutomation(tampered);
    assert.equal(findings.length, 1, `${code} 必须被检查抓到`);
    assert.equal(findings[0]?.code, "AUTOMATION_HUMAN_ACTION", `${code} 的违规码`);
  }

  const bypassed = files.map((file) =>
    file.path === "pipeline.sh" ? { ...file, content: `${file.content}\ngit commit --no-verify\n` } : file,
  );
  assert.equal(inspectAutomation(bypassed)[0]?.code, "AUTOMATION_GATE_BYPASS", "闸门绕过也必须被抓到");
});

test("注释与文档可以解释边界，不会被误判成越界", () => {
  const files: EmittedFile[] = [
    { path: "README.md", content: "不要调用 forge inbox --promote / forge confirm。\n" },
    { path: "pipeline.sh", content: "# 这里解释为什么不能调用 forge inbox --promote\nforge compile --vault x\n" },
    { path: "task-scheduler.xml", content: "<!-- 不含 confirm -->\n<Arguments>pipeline.ps1</Arguments>\n" },
  ];
  assert.deepEqual(inspectAutomation(files), []);
});

test("确定性：同一组输入两次生成逐字节相同，且一律 LF", () => {
  const first = bundle();
  const second = bundle();
  assert.deepEqual(second, first);
  for (const file of first) {
    assert.doesNotMatch(file.content, /\r/, `${file.path} 混进了 CRLF：R6 要求逐字节确定`);
    assert.equal(file.content.endsWith("\n"), true, `${file.path} 必须以一个换行结尾`);
  }
});

test("生成物：两种调度器 + 两条流水线都在，清单列全", () => {
  const files = bundle();
  assert.deepEqual(
    files.map((file) => file.path),
    [".forge-manifest.json", "README.md", "pipeline.cron", "pipeline.ps1", "pipeline.sh", "task-scheduler.xml"],
  );
  const manifest = JSON.parse(contentOf(files, ".forge-manifest.json")) as { generator: string; files: string[] };
  assert.equal(manifest.generator, "automate");
  assert.ok(manifest.files.includes("pipeline.sh"));
  assert.ok(manifest.files.includes("task-scheduler.xml"));
});

test("脚本把日期当输入：显式传 --today，不用隐式时钟生成产物", () => {
  const files = bundle();
  const sh = contentOf(files, "pipeline.sh");
  const ps = contentOf(files, "pipeline.ps1");
  const cron = contentOf(files, "pipeline.cron");

  for (const text of [sh, ps]) {
    assert.match(text, /FORGE_TODAY/, "日期必须可以由 FORGE_TODAY 固定");
    assert.match(text, /--today/, "巡检与周报必须显式拿到日期");
    assert.match(text, /FORGE_IMPORT/, "导入是可选的：设了才 compile --import，不设不编造输入");
  }
  assert.match(sh, /--today "\$TODAY"/);
  assert.match(ps, /'--today', \$Today/);
  assert.match(cron, /cd '\/home\/me\/forge'/, "cron 必须从生成时的工作目录启动");
  assert.match(cron, /bash '\/home\/me\/forge\/pipeline\.sh'/, "cron 调用的必须是生成的流水线");
});

test("调度器指向真实的生成目录，而不是从工作目录猜同名文件", () => {
  const files = renderAutomationBundle({ workdir: "/srv/forge", bundleDir: "auto" });
  assert.match(contentOf(files, "pipeline.cron"), /cd '\/srv\/forge' && bash 'auto\/pipeline\.sh'/);
  assert.match(contentOf(files, "task-scheduler.xml"), /-File "auto\/pipeline\.ps1"/);
  assert.match(contentOf(files, "task-scheduler.xml"), /<WorkingDirectory>\/srv\/forge<\/WorkingDirectory>/);
});

test("PowerShell 与 XML 的转义不是装饰：路径里的引号不会拼坏脚本", () => {
  const files = renderAutomationBundle({ forgeBin: "C:\\Program Files\\forge\\forge.exe", workdir: "C:\\O'Brien" });
  const ps = contentOf(files, "pipeline.ps1");
  const xml = contentOf(files, "task-scheduler.xml");
  assert.match(ps, /'C:\\Program Files\\forge\\forge\.exe'/, "PowerShell 字符串里的路径必须原样");
  assert.match(xml, /C:\/O&apos;Brien\/pipeline\.ps1/, "XML 里的单引号必须转义");
  assert.doesNotMatch(xml, /O'Brien/, "未转义的引号会让任务导入失败");
});

test("--list 的正文覆盖三档，并明确说明配方只执行第一档", () => {
  const text = renderAutomationPolicy();
  for (const title of ["一、可以全自动", "二、可以自动准备", "三、设计上禁止自动化"]) {
    assert.match(text, new RegExp(title));
  }
  assert.match(text, /candidate-promote/);
  assert.match(text, /model-to-assets/);
  assert.match(text, /生成的配方只执行第一档/);
  assert.equal(text.endsWith("\n"), true);
  assert.doesNotMatch(text, /\r/);
});
