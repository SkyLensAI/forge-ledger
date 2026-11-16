/**
 * forge capture · 弹窗
 *
 * 两个动作，正好对应 implement2.md 给这个出口写的四个字：**取用 + 采集**。
 * 它不含判定，只把结果摆出来：取用回的那段文字可以原样复制进任何模型，
 * 采集的结果里"新增几条 / 跳过几条 / 为什么"要说清楚——
 * **采集最危险的失败是安静地什么都没采到**。
 */

const query = document.getElementById("query");
const out = document.getElementById("out");
const status = document.getElementById("status");

/** @param {string} text @param {boolean} [isError] */
function show(text, isError = false) {
  out.hidden = false;
  out.textContent = text;
  out.className = isError ? "error" : "";
}

document.getElementById("ask").addEventListener("click", async () => {
  const value = query.value.trim();
  if (value.length === 0) {
    status.textContent = "先写一句查询。";
    return;
  }
  status.textContent = "取用中…";
  const result = await chrome.runtime.sendMessage({ type: "forge:context", query: value });
  if (result?.ok === true) {
    show(result.text);
    status.textContent = "· 这段文字可以直接贴进任何模型的上下文。";
    return;
  }
  show(String(result?.reason ?? "取用失败"), true);
  status.textContent = "";
});

document.getElementById("capture").addEventListener("click", async () => {
  status.textContent = "采集中…";
  const result = await chrome.runtime.sendMessage({ type: "forge:capture" });
  if (result?.ok === true) {
    const lines = [
      `采到 ${result.received ?? 0} 条 · 新增 ${result.fresh ?? 0} 条 · 已采过 ${result.duplicates ?? 0} 条`,
      result.sourceId === null
        ? "· 没有新东西，sources/ 一个字节都没写。"
        : `· 落成来源 ${result.sourceId}（${result.created ? "新建" : "已经存在"}）。接着跑 \`forge compile\`。`,
    ];
    if ((result.skipped ?? []).length > 0) {
      lines.push(`⚠ 跳过 ${result.skipped.length} 条：`);
      for (const item of result.skipped) lines.push(`  - ${item}`);
    }
    show(lines.join("\n"));
    status.textContent = "";
    return;
  }
  show(String(result?.reason ?? "采集失败"), true);
  if ((result?.skipped ?? []).length > 0) show(`${result.reason}\n\n${result.skipped.join("\n")}`, true);
  status.textContent = "";
});
