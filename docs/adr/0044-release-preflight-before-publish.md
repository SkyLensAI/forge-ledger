---
schema_version: 1
id: dec_06GWAN2J00V8MGMMYQRM7FVRR2
type: decision
status: accepted
created: "2026-11-10"
last_confirmed: "2026-11-10"
supersedes: null
origin_incident: "file://listing/SUBMISSION.md#t:成为一个真正可安装的命令"
sources:
  - "file://listing/SUBMISSION.md#t:成为一个真正可安装的命令"
  - "file://README.md#t:一个真正可安装的"
  - "file://docs/gates/bypass-matrix.md#t:闸门 5 · 发布门"
  - "file://docs/adr/0041-listing-is-a-draft-not-a-submission.md#t:需要账号、仓库 URL、一个真正可安装的"
sensitivity: internal
confidence: 0.9
---

# 发布门要检查包结构，而不是只打一个占位

## 问题

`release.yml` 的发布步骤一直是一句占位：

```yaml
- name: publish (placeholder)
  run: echo "Phase 0：发布门只做判定，产物发布在 Phase 2 接入"
```

而 `release.mjs` 的头部还写着"provenance / emit / eval 尚未覆盖"。这两句话在
Phase 1–8 都落盘之后已经**不是事实**：`gate:ci` 会跑那些检查。但更实际的问题是：
即使 `gate:ci` 全绿，`pnpm publish` 仍然可能发出一个**装不上**的包——

- `@forge/mcp` 依赖 `@forge/core` / `@forge/schema` / `@forge/store`，
  而这些包如果还是 `private`，npm 上装不到依赖；
- 版本还是 `0.0.0`，它是"尚未发布"的占位，不是一次发布；
- 没有 `files` 的包会把测试与临时文件一起发出去；
- 没有 `publishConfig.access` / `engines.node` 的包会在 registry 上表现不一致。

这些都不是 `gate:ci` 的职责，也不该混进那个已经很长的大闸门。

## 考虑过的选项

1. **继续保留占位。** 否决。上架包（S31）已经生成了一个指向 `forge-mcp` 的
   可提交 draft；如果发布路径永远不接，那份 draft 就永远只是形状正确。
2. **让人在笔记本上 `pnpm publish`。** 否决。那会让闸门 5 的"发布只能从 CI 发出"
   变成一句口号；凭据与可追溯性也一起消失。
3. **在 `release.mjs` 里顺手把包结构也判了。** 否决。`release.mjs` 已经负责
   CI/tag/变更集三个问题；再塞进"哪些包能发"会让它的失败原因变模糊。
4. **加一个发布前检查脚本，加在 `gate:release` 之后、`publish` 之前。** 采纳。

## 选定

- 新增 `scripts/gates/release-preflight.mjs`，只回答"现在这批 package.json
  能不能被 `pnpm -r publish` 正确发出去"：
  - 版本不是 `0.0.0`；
  - `@forge/mcp` 不是 `private`；
  - 每个可发布包的 `@forge/*` 依赖也可发布（否则 npm 上装不到）；
  - 每个可发布包有 `engines.node >= 24`、`files`、`publishConfig.access`；
  - `@forge/extension` 仍然是 `private`（浏览器扩展不通过 npm 分发）；
  - `NPM_TOKEN` / `FORGE_NPM_TOKEN` 存在（本地演练用 `--allow-missing-token`）。
- `release.mjs` 增加一条：`version === "0.0.0"` 直接红。占位版本不是一次发布。
- `release.yml`：
  - `setup-node` 配 `registry-url: https://registry.npmjs.org`；
  - 在 `gate:release` 之后跑 `release-preflight.mjs`；
  - 用 `pnpm -r publish --access public --provenance --no-git-checks` 发布；
  - `NODE_AUTH_TOKEN` 取自 `secrets.NPM_TOKEN`。
- **哪些包去掉 `private` 是人的决定。** 本 ADR 只把"去掉之后依赖链是否完整"
  变成机器判定；它不替人决定 scope、版本号、registry 凭据。

## 后果

- **好**：发布不会再发出一个依赖缺失或元数据不全的包；失败发生在 publish 之前，
  而不是在用户 `npm install` 的时候。
- **好**：`release.mjs` 的注释回到事实：provenance / emit / eval 由 `gate:ci`
  覆盖，本脚本不重复写第二份。
- **代价**：真正发布仍然需要人：npm scope 所有权、`NPM_TOKEN`、版本号、
  以及把要发布的包从 `private` 改成可发布。这些是账号与商业决定，不是代码。
- **残余风险**：preflight 只检查结构，不检查包在安装后的行为；没有发布后的
  smoke test，也没有自动回滚。`@forge/mcp` 的 `.ts` 源码依赖 Node 原生类型擦除
  （ADR-0011），所以 Node 下限必须随包声明——preflight 能检查声明，不能检查
  用户的 Node 版本。
