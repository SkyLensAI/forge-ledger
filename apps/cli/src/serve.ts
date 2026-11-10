/**
 * `forge serve` —— 本机回环桥（S23 的另一半）。
 *
 * 浏览器扩展要"取用 + 增量采集"，而它**不能**读文件、不能写库、不能做判定
 * （那是 `@forge/core` / `@forge/store` 的活，而浏览器执行不了 TypeScript，
 * 见 `packages/core/src/selectors.ts` 的头注释）。所以中间必须有一个本机进程：
 * **扩展只做 DOM 胶水，判定全在这里。**
 *
 * ## 三条安全性质，缺一条这个命令就不该存在
 *
 * 1. **只绑回环地址**（`127.0.0.1`）。绑 `0.0.0.0` 等于把你的资产库挂到局域网上，
 *    而这个命令的存在理由是"浏览器和本机程序说句话"，不是"对外提供一个服务"。
 * 2. **需要 token**。回环不等于安全：**任何一个网页**都能向 `http://127.0.0.1:8787`
 *    发请求。没有 token 的话，你在浏览器里打开的任何页面都能读走你整个库。
 *    token 由本进程生成并打在 stderr 上，人要手动填进扩展的选项页——
 *    这一步的麻烦是有意的：它让"谁被允许读这个库"变成一个显式动作。
 * 3. **CORS 只放行扩展来源**（`chrome-extension://` / `moz-extension://`）与无来源的
 *    命令行。网页（`https://…`）一律 403，**即使它拿到了 token**——
 *    纵深防御，因为 token 可能被截屏、被贴进聊天记录。
 *
 * ## 它为什么不是"MCP 的另一个口"
 *
 * MCP（`apps/mcp`）给模型客户端用（stdio，客户端拉起）；这个桥给**浏览器**用
 * （HTTP，人显式启动）。两者的消费者、生命周期、信任模型都不同，所以是两个宿主，
 * 但**判定是同一份**：两边都走 `vault.context()` 与 `vault.capture()`。
 */
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DEFAULT_BUDGET_TOKENS, MIN_BUDGET_TOKENS } from "@forge/core";
import { deliverSelectorDecision, openVault, type FetchText } from "@forge/store";

/** 默认端口。写死一个数字是为了让扩展的选项页有一个能预填的值。 */
export const DEFAULT_PORT = 8787;

/** 请求体上限：一份采集载荷不该有几兆。超过就回 413，不做无上限的缓冲。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 超限之后还愿意读多少（然后丢弃）。
 *
 * 为什么不是"一超限就 `request.destroy()`"：那样**客户端读不到 413**——
 * 它只会看到一个 `ECONNRESET`，而"请求太大"与"桥挂了"在客户端看来一模一样。
 * 所以先回一个明确的 413，同时把剩下的字节读掉丢弃；只有在真的离谱时（这条线）
 * 才断连接。校准这条线的依据是**回答的质量**，不是内存。
 */
export const DRAIN_LIMIT_BYTES = 8 * 1024 * 1024;

export interface ServeOptions {
  vault: string;
  port?: number;
  /** `YYYY-MM-DD`：新鲜度基准日。不给 = 没有校验新鲜度。 */
  today?: string | null;
  /**
   * 访问 token。不给就**生成一个**并打在 stderr 上。
   *
   * 为什么不给默认值：一个写死的默认 token 等于没有 token，
   * 而"没有 token 的回环服务"在任何一个网页里都能被读到。
   */
  token?: string;
  /** 远端选择器配置的地址。不给 = 热更新这条线关着（只用扩展自带的那份）。 */
  selectorUrl?: string | null;
  /** 抓远端配置的手段（可注入，于是"远端挂了"这条路能被测）。 */
  fetchText?: FetchText;
  log?: (line: string) => void;
}

export interface RunningServer {
  port: number;
  token: string;
  close(): Promise<void>;
}

/**
 * 启动桥。
 *
 * @param {ServeOptions} options
 * @returns {Promise<RunningServer>}
 */
export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const token = options.token ?? randomBytes(24).toString("hex");
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const vault = openVault(options.vault);
  const fetchText = options.fetchText ?? fetchTextOverNetwork;
  const today = options.today ?? null;

  const http = createHttpServer((request, response) => {
    Promise.resolve()
      .then(() =>
        route(request, response, {
          token,
          log,
          today,
          selectorUrl: options.selectorUrl ?? null,
          fetchText,
          vault,
        }),
      )
      .catch((error: unknown) => {
        // 一条请求炸了不该带走整个进程：回 500 并留痕。
        const message = error instanceof Error ? error.message : String(error);
        log(`✗ 处理 ${request.method ?? "?"} ${request.url ?? "?"} 时抛错：${message}`);
        if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", "internal error\n");
      });
  });

  const port = options.port ?? DEFAULT_PORT;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    // **绑 127.0.0.1**，不是 0.0.0.0：这条边界由这一行写死，不靠调用方记得。
    http.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });

  return {
    port,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

interface Route {
  token: string;
  log: (line: string) => void;
  today: string | null;
  selectorUrl: string | null;
  fetchText: FetchText;
  vault: ReturnType<typeof openVault>;
}

/**
 * 路由。**判定一行都不在这里**：它调 `vault.context()` / `vault.capture()` /
 * `deliverSelectorDecision()`，然后把结果包成 HTTP。
 *
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @param {Route} route
 * @returns {Promise<void>}
 */
async function route(request: IncomingMessage, response: ServerResponse, route: Route): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(DEFAULT_PORT)}`);
  const method = request.method ?? "GET";
  const origin = request.headers.origin;

  // 网页来的请求：**连 token 都不检查就拒**。见文件头第 3 条。
  if (origin !== undefined && !isExtensionOrigin(origin)) {
    send(response, 403, "text/plain; charset=utf-8", `拒绝：这个来源不被放行（${origin}）\n`);
    return;
  }
  // 回显来源而不是 `*`：`*` 会让"哪些来源被放行"这件事从代码里消失。
  if (origin !== undefined) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "origin");

  if (method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-headers": "content-type, x-forge-token",
      "access-control-allow-methods": "GET, POST",
    });
    response.end();
    return;
  }

  if (request.headers["x-forge-token"] !== route.token) {
    send(
      response,
      401,
      "text/plain; charset=utf-8",
      "缺 token 或 token 不对：把 `forge serve` 打在 stderr 上的那串填进扩展的选项页\n",
    );
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    send(response, 200, "application/json; charset=utf-8", `${JSON.stringify({ ok: true })}\n`);
    return;
  }

  if (method === "GET" && url.pathname === "/selectors") {
    const have = integerParam(url, "have", 0);
    if (have === null) {
      send(response, 400, "text/plain; charset=utf-8", "have 必须是整数（你手里那份配置的 revision）\n");
      return;
    }
    const delivered = await deliverSelectorDecision({
      haveRevision: have,
      url: route.selectorUrl,
      fetchText: route.fetchText,
    });
    route.log(`· /selectors(have=${String(have)})：${delivered.decision.why}`);
    send(response, 200, "application/json; charset=utf-8", `${JSON.stringify(delivered.decision)}\n`);
    return;
  }

  if (method === "GET" && url.pathname === "/context") {
    const query = url.searchParams.get("q") ?? "";
    if (query.trim().length === 0) {
      send(response, 400, "text/plain; charset=utf-8", "缺 q：取用要有一句查询\n");
      return;
    }
    const budget = integerParam(url, "budget", DEFAULT_BUDGET_TOKENS);
    if (budget === null || budget < MIN_BUDGET_TOKENS) {
      send(response, 400, "text/plain; charset=utf-8", `budget 要是不小于 ${String(MIN_BUDGET_TOKENS)} 的整数\n`);
      return;
    }
    const run = route.vault.context({ query, budget, today: url.searchParams.get("today") ?? route.today });
    if (run.violations.length > 0) {
      // 自证失败 = 缺陷。**不把夹着问题的注入发出去**：那会让用的人拿到坏上下文而不知道。
      send(response, 500, "text/plain; charset=utf-8", `注入块违反了它自己的承诺：\n${run.violations.join("\n")}\n`);
      return;
    }
    // text/plain：扩展把它原样塞进输入框，不解析 Markdown。
    send(response, 200, "text/plain; charset=utf-8", run.rendered);
    return;
  }

  if (method === "POST" && url.pathname === "/capture") {
    const body = await readBody(request);
    if (body === null) {
      // 回一个明确的 413，而不是把连接掐掉：掐掉的话客户端只知道"出错了"。
      send(
        response,
        413,
        "text/plain; charset=utf-8",
        `请求体超过 ${String(MAX_BODY_BYTES)} 字节：采集载荷不该有这么大\n`,
      );
      return;
    }
    let report: unknown;
    try {
      report = JSON.parse(body) as unknown;
    } catch (error) {
      send(
        response,
        400,
        "text/plain; charset=utf-8",
        `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}\n`,
      );
      return;
    }
    const outcome = route.vault.capture(report);
    send(response, outcome.ok ? 200 : 400, "application/json; charset=utf-8", `${JSON.stringify(outcome)}\n`);
    return;
  }

  send(response, 404, "text/plain; charset=utf-8", `没有这个接口：${method} ${url.pathname}\n`);
}

/**
 * 通过网络抓文本。**拿不到就返回 null**，而不是抛——
 * 一个拿不到远端配置的浏览器不该因此采不到东西（它用自己那份兜底）。
 *
 * @param {string} url
 * @returns {Promise<string | null>}
 */
async function fetchTextOverNetwork(url: string): Promise<string | null> {
  if (!/^https?:\/\//.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string | undefined} origin
 * @returns {boolean}
 */
function isExtensionOrigin(origin: string): boolean {
  return origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");
}

/**
 * @param {ServerResponse} response
 * @param {number} status
 * @param {string} contentType
 * @param {string} body
 * @returns {void}
 */
function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

/**
 * 读请求体，**带上限**。无上限的缓冲是这一层最容易留下的一个洞。
 *
 * 超限之后继续读并丢弃（到 `DRAIN_LIMIT_BYTES` 为止），而不是立刻掐断连接：
 * 掐断的话客户端只会看到 `ECONNRESET`，**读不到那条 413**——
 * 而"请求太大"与"桥挂了"在客户端看来必须不一样。
 *
 * @param {IncomingMessage} request
 * @returns {Promise<string | null>} 超限返回 null
 */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > DRAIN_LIMIT_BYTES) {
      // 离谱到这条线之外：不再陪着读，断掉。
      request.destroy();
      return null;
    }
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      // 已经超了：不再留字节，但继续把它读完（否则响应发不出去）。
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  return tooLarge ? null : Buffer.concat(chunks).toString("utf8");
}

/**
 * @param {URL} url
 * @param {string} name
 * @param {number} fallback
 * @returns {number | null}
 */
function integerParam(url: URL, name: string, fallback: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
