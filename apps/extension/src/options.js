/**
 * forge capture · 选项页
 *
 * 唯一要做对的事：**别把 token 悄悄丢掉**。它每次重启 `forge serve` 都会换，
 * 而"填了没生效"与"桥没开"在界面上长得一模一样——
 * 所以保存之后要回读一次，把**存进去的值**显出来。
 */

const url = document.getElementById("url");
const token = document.getElementById("token");
const saved = document.getElementById("saved");

const KEY = "forge.bridge";

const stored = await chrome.storage.local.get(KEY);
const value = stored[KEY] ?? {};
url.value = typeof value.url === "string" ? value.url : "http://127.0.0.1:8787";
token.value = typeof value.token === "string" ? value.token : "";

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ [KEY]: { url: url.value.trim(), token: token.value.trim() } });
  // 回读，不回声：显示"我以为存了什么"是这类页面最常见的谎。
  const again = await chrome.storage.local.get(KEY);
  saved.textContent = `已保存：${again[KEY]?.url ?? ""}（token ${again[KEY]?.token ? "已设置" : "为空"}）`;
});
