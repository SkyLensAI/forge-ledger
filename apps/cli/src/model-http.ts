/**
 * 真实模型调用 —— **整个仓库里唯一碰网络的地方**（连同 `apps/cli` 的参数与进程）。
 *
 * 它只做一件事：把一次响应拿回来。它**不做**判断、不解析、不 sanitize——
 * 那些全在 `packages/core` 的纯函数里，所以回放与真实调用走的是**同一段**判定。
 * 这也是"无 API key 也能跑通全链路"能成立的原因：这一步可以整段被换掉
 * （换成录像），而它后面的每一行代码都不用动。
 *
 * 为什么留在这里而不是建一个 `packages/llm`（directory.md 的 v0 清单里有它）：
 * 判据是"出现第二个消费者再下沉"（ADR-0018 / ADR-0004）。现在只有 CLI 一个消费者，
 * 而 MCP server 是 S22 的事——那时它带着"要怎么传 key、要不要流式"这些
 * 真实约束一起下来，比现在猜着建一个包干净得多。
 *
 * 只有一个 provider 适配器（OpenAI 兼容的 `/chat/completions`）。
 * 加第二个的判据同上：有人真的用它。**已知未验证**：本仓库没有 key，
 * 所以这条路径只被桩 fetch 测过（`apps/cli/test/extract.test.ts`），
 * 没被真实端点测过。这是如实记账，不是"应该没问题"。
 */
import type { ModelRequest } from "@forge/core";

export interface HttpModelOptions {
  /** 形如 `https://api.example.com/v1`（不带 `/chat/completions`）。 */
  endpoint: string;
  model: string;
  apiKey: string;
  /** 注入点：测试用桩替换它，于是"怎么拼请求、怎么读响应"是可测的。 */
  fetchImpl?: typeof fetch;
}

/**
 * 调一次模型，拿回响应的正文。
 *
 * 失败一律抛错，**没有降级**：调用失败时返回空串会让"抽不出来"和"调用挂了"
 * 在报告里长得一样，而两者的修法完全不同（一个是调 harness，一个是看网络/key）。
 *
 * @param {HttpModelOptions} options
 * @param {ModelRequest} request
 * @returns {Promise<string>}
 */
export async function completeOnce(options: HttpModelOptions, request: ModelRequest): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${options.endpoint.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      max_tokens: request.max_tokens,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`模型端点返回 ${String(response.status)}：${text.slice(0, 300)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`模型端点的响应不是 JSON（前 200 字符）：${text.slice(0, 200)}`);
  }

  const content = readContent(parsed);
  if (content === null) {
    throw new Error(`模型响应里没有 choices[0].message.content（前 200 字符）：${text.slice(0, 200)}`);
  }
  return content;
}

/**
 * @param {unknown} parsed
 * @returns {string | null}
 */
function readContent(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const choices = (parsed as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : null;
}
