/**
 * 边缘的网络适配器 —— 用**桩 fetch** 测。
 *
 * 这一段代码只做两件事：把请求拼对、把响应读对。两件事都能在不起网络的情况下测，
 * 所以没有理由不测——而"没有 key 所以没测"是一个很舒服、也很贵的借口：
 * 它会让 `--record` 这条路在第一次真用的时候才第一次执行。
 *
 * **没被覆盖的是真实端点**（鉴权是否被接受、`choices[0].message.content` 之外
 * 还有没有别的形状、超时怎么表现）。那是如实记账，写在 ADR-0021 的残余风险里。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { completeOnce } from "../src/model-http.ts";
import type { ModelRequest } from "@forge/core";

const REQUEST: ModelRequest = { system: "系统提示", user: "用户内容", max_tokens: 512 };

/**
 * 造一个桩 fetch：记下调用，返回给定响应。
 *
 * @param {{status?: number, body?: string}} [options]
 * @returns {{calls: Array<{url: string, init: RequestInit}>, fetchImpl: typeof fetch}}
 */
function stub(options: { status?: number; body?: string } = {}): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const status = options.status ?? 200;
  const body = options.body ?? JSON.stringify({ choices: [{ message: { content: "回答" } }] });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  return { calls, fetchImpl };
}

test("拼请求：端点拼对、system/user 分开进 messages、带上 max_tokens 与鉴权头", async () => {
  const { calls, fetchImpl } = stub();
  const text = await completeOnce(
    { endpoint: "https://example.test/v1/", model: "某模型", apiKey: "sk-测试", fetchImpl },
    REQUEST,
  );

  assert.equal(text, "回答");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://example.test/v1/chat/completions");

  const init = calls[0]?.init ?? {};
  assert.equal((init.headers as Record<string, string>)["authorization"], "Bearer sk-测试");
  const payload = JSON.parse(String(init.body)) as {
    model: string;
    max_tokens: number;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(payload.model, "某模型");
  assert.equal(payload.max_tokens, 512);
  assert.deepEqual(payload.messages, [
    { role: "system", content: "系统提示" },
    { role: "user", content: "用户内容" },
  ]);
});

test("端点结尾有斜杠时不拼出 `//chat/completions`", async () => {
  const { calls, fetchImpl } = stub();
  await completeOnce({ endpoint: "https://example.test/v1///", model: "m", apiKey: "k", fetchImpl }, REQUEST);
  assert.equal(calls[0]?.url, "https://example.test/v1/chat/completions");
});

test("响应形状不对时**抛错**，不返回空串", async () => {
  const empty = stub({ body: JSON.stringify({ choices: [] }) });
  await assert.rejects(
    () => completeOnce({ endpoint: "https://e.test/v1", model: "m", apiKey: "k", fetchImpl: empty.fetchImpl }, REQUEST),
    /choices\[0\]\.message\.content/,
  );

  const notJson = stub({ body: "<html>502</html>" });
  await assert.rejects(
    () => completeOnce({ endpoint: "https://e.test/v1", model: "m", apiKey: "k", fetchImpl: notJson.fetchImpl }, REQUEST),
    /不是 JSON/,
  );
});

test("HTTP 非 2xx 时抛错，并把状态码与响应体带上", async () => {
  const { fetchImpl } = stub({ status: 429, body: "rate limited" });
  await assert.rejects(
    () => completeOnce({ endpoint: "https://e.test/v1", model: "m", apiKey: "k", fetchImpl }, REQUEST),
    /429.*rate limited/s,
  );
});
