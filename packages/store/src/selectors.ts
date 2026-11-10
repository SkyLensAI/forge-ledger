/**
 * 选择器配置的**投递**（S23 的边缘那一半）—— 纯逻辑在 `@forge/core`，
 * 这里是唯一碰网络的地方。
 *
 * 为什么网络要走一个**注入的** `fetchText`：这样"远端拿不到"、"远端返回的不是 JSON"、
 * "远端返回的 JSON 是坏配置"这三条路都能被测试，而不需要真的去连一个外部地址。
 * 与 `Model` 那条接缝同一个形状（ADR-0021）：**宿主注入的是手段，判定仍然只有一份**。
 */
import { decideSelectorRevision, type SelectorConfig } from "@forge/core";

/** 抓一份文本。拿不到就返回 null——**不抛**，"远端挂了"是一个正常结果。 */
export type FetchText = (url: string) => Promise<string | null>;

export interface SelectorDecisionInput {
  /** 调用方手里那份的 revision。 */
  haveRevision: number;
  /** 远端配置的地址。null = 没配远端。 */
  url: string | null;
  fetchText: FetchText;
}

export interface SelectorDecision {
  /** 给调用方的结论，原样返回给扩展。 */
  decision: { use: "remote"; config: SelectorConfig; why: string } | { use: "local"; why: string };
  /** 远端到底拿到没有。它进日志——"热更新为什么没生效"要能被回答。 */
  fetched: boolean;
}

/**
 * 去拿远端配置，然后决定用谁。
 *
 * @param {SelectorDecisionInput} input
 * @returns {Promise<SelectorDecision>}
 */
export async function deliverSelectorDecision(input: SelectorDecisionInput): Promise<SelectorDecision> {
  if (input.url === null || input.url.trim().length === 0) {
    return { decision: decideSelectorRevision(input.haveRevision, null), fetched: false };
  }

  const text = await input.fetchText(input.url);
  if (text === null) {
    // 拿不到远端**不是错误**：采集不该因为一个配置服务器挂了而停摆。
    return {
      decision: decideSelectorRevision(input.haveRevision, null),
      fetched: false,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    // 拿到了，但不是 JSON：这与"拿不到"分开记账——前者是配置发坏了，要去修它。
    return {
      decision: decideSelectorRevision(input.haveRevision, { notJson: String(error) }),
      fetched: true,
    };
  }
  return { decision: decideSelectorRevision(input.haveRevision, parsed), fetched: true };
}
