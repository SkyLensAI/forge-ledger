---
schema_version: 1
id: dec_06GV05GPG015QD6E4X09KWRCCP
type: decision
status: accepted
created: "2026-11-06"
last_confirmed: "2026-11-06"
supersedes: null
origin_incident: "file://docs/implement1.md#t:模型负责抽取，代码负责不信任"
sources:
  - "file://docs/implement1.md#t:模型负责抽取，代码负责不信任"
  - "file://docs/implement2.md#t:Extractor：LLM"
  - "file://docs/implement2.md#t:连续 3 天稳定"
  - "file://docs/implement1.md#t:用便宜模型，冲突裁决才用贵模型"
  - "file://AGENTS.md#t:产出必须逐字节确定"
sensitivity: internal
confidence: 0.8
---

# 模型是一台**可注入的同步** `Model`：真实调用在边缘，评测对着录像跑

## 问题

Phase 4（S15）要接第一处模型。而"接一处模型"这件事有两种接法，
它们的差别在**半年后**才会显形：

- 一种是把网络调用塞进抽取器里。写起来最直接，代价是：抽取链路上任何一段判定
  都变得不可复现——同一份输入今天和明天可能得到不同的输出，而"改了 harness 之后
  变好了吗"这个问题从此没有答案（implement2.md S17 要求**调 harness 而不是换模型**，
  而那句话的前提是能比较两次改动）。
- 一种是把模型做成**可注入、可回放**的东西，真实的网络调用退到一个角落。

还有第二个问题：`Extractor` 接口是同步的（Phase 3 定的）。一个异步的模型
会把 `async` 渗进 runner、闸门、报告——而它们全都是确定性的东西。

## 考虑过的选项

1. **把 `Extractor.extract` 改成 `async`**，真实调用直接写进去。
   接口最"自然"，但 `async` 会一路渗到 `evals/runner/`、`packages/store` 与 CLI，
   而且**每一处判定都开始可能"还没完成"**——确定性从架构上消失。
2. **保持同步，但模型实现内部用同步的网络调用**（`execSync` 之类的招）。
   把"同步"这个性质建立在一个 hack 上，而且它照样不可复现。
3. **`Model` 是一个同步的纯接缝，真实调用住在边缘适配器里，评测用录制/回放。**
4. **干脆不做评测，只做一条 `forge extract --live`。**
   那就是 implement1.md 反模式 3（"没有 eval 就说效果不错"）换个说法。

## 选定

**选 3。** 具体形状：

- `packages/core/src/model.ts` 定义 `Model { id, complete(request): ModelResponse }`——
  **同步**。于是「渲染请求 → 解析响应 → sanitize → 守卫」整条链是纯函数，
  可以用固定字符串做快照测试，与 `emit` 的确定性是同一种确定（R6）。
- 真实的网络调用住在 `apps/cli/src/model-http.ts`（**全仓库唯一碰网络的地方**），
  它只负责**把响应录下来**。抽取用的永远是录像（`packages/store/src/cassette.ts`）。
- **请求的键是提示词的指纹**（`JSON.stringify([system, user, max_tokens])` 的 sha256），
  不是用例 ID。提示词改一个字，键就变；旧录像对不上新问题时**报错**，
  而不是悄悄拿一段回答另一个问题的文字来充数。
- **仓库里不放任何 cassette。** 没有 API key 就录不出真实录像，而放一份
  手写的"合成录像"进仓库，会让人把它的分数读成模型的质量——
  那是"让模型给自己发合格证"的另一种写法。

## 后果

- **好**：没有 API key 也能跑**完整的**抽取链路——这是 implement1.md §4 的架构纪律，
  现在它在模型这一环也成立（此前只在 compile/lint/emit 上成立）。
- **好**：评测可比。换提示词、换分块、换受控词表之后，分数的变化是因为那些改动。
- **好**：一条候选能被追溯到**当时那段响应原文**，而不是"模型是这么说的"——
  与产品对用户资产的出处要求是同一条（ADR-0009）。
- **好**：`Model` 只有两个成员，所以"换模型"的代价是换一个对象。
  implement2.md 说"够难就调 harness，不是换模型"——这句话现在有执行体了：
  换模型便宜到不构成诱惑，于是调 harness 才是唯一划算的动作。
- **代价**：多一层间接（`Model` + cassette + 边缘适配器）。
  它买到的东西是"可复现"，而这是整个产品的地基。
- **代价**：`extract` 是 CLI 里唯一异步的命令（`--record` 要网络）。
  异步被限制在"把响应取回来"这一步，不渗进任何判定。
- **残余风险**：`model-http.ts` 只被**桩 fetch** 测过（`apps/cli/test/extract.test.ts`），
  没有被真实端点测过——本仓库没有 key。逐步接入真实端点时需要验的是三件事：
  鉴权头、`choices[0].message.content` 的取值、以及超时行为。**这是记账，不是"应该没问题"。**
- **残余风险**：只有一个 provider 适配器（OpenAI 兼容的 `/chat/completions`）。
  加第二个的判据是"有人真的用它"（ADR-0004 的同一条理由），不是"主流模型有几种"。
- **残余风险**：录像只证明"这段响应会被怎么处理"，**不**证明模型现在还会这么答。
  所以它在评测里给出的分数不是模型的质量。这条限制写在 `evals/README.md` 里，
  不留给读者自己发现。
