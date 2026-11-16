---
schema_version: 1
id: dec_06GY8AT36MSF331D4QYBVV3Q0D
type: decision
status: accepted
created: "2026-11-16"
last_confirmed: "2026-11-16"
supersedes: null
origin_incident: "file://demo/README.md#t:页面没有外部依赖"
sources:
  - "file://README.md#t:Byte-for-byte reproducible."
  - "file://demo/README.md#t:页面没有外部依赖"
  - "file://scripts/gates/lib/policy.mjs#t:.github/workflows/"
  - "file://STATUS.md#t:demo/` 的每一页、每一处出处都来自本仓库自己的"
sensitivity: internal
confidence: 0.9
---

# 用 gh-pages 分支发布已经生成好的 demo

## 问题

`demo/` 是 `forge demo --repo` 的确定性产物：页面没有外部脚本、样式或字体，
直接打开 `index.html` 就能看。但它此前只能本地打开——访客要先 clone、
装 Node 24 和 pnpm，才能看到第一屏。

推广需要一个公开 URL，而且这个 URL 必须指向**和仓库逐字节相同的产物**。

最自然的载体是 `.github/workflows/pages.yml`，但它是受保护路径（闸门 3/5
本体）。按 R2，受保护路径的改动必须由人执行；agent 不应亲自改，也不应设置
`FORGE_GATE_OVERRIDE` 给自己放行（R3）。因此需要一条**不碰受保护路径**、
又能达到同一结果的发布路径。

## 考虑过的选项

1. **新增 `.github/workflows/pages.yml`。** 对结果而言最直接，但它落在受保护
   路径上：agent 写入会被闸门 1 拦下，绕过则违反 R3。留给以后由人决定。
2. **把 demo 复制进 `docs/`，用分支源 `/docs` 发布。** 否决。那会产生第二份
   需要同步的产物，而 `forge bootstrap` 只校验 `demo/`；第二份迟早漂移。
3. **在发布流程里重新跑 `forge demo`。** 否决。发布出来的字节会取决于发布
   环境里安装的依赖版本，而不是提交里那一份已经通过一致性检查的产物。
4. **把 `demo/` 原样推到一个孤立的 `gh-pages` 分支，Pages 从该分支根发布。**
   采纳。它不改任何受保护路径，也不引入第二个生成器。

## 选定

- 新增 `scripts/publish-demo.mjs`：在临时 worktree 里创建或更新 `gh-pages`
  分支，内容**只有 `demo/` 的字节**，外加一个 `.nojekyll`（避免 Jekyll 处理）。
  已经存在的 `gh-pages` 分支走快进提交，不使用 `--force`。
- GitHub Pages 的 Source 设为 **`gh-pages` 分支 / 根目录**（一次性仓库设置，
  可用 `gh api repos/<owner>/<repo>/pages` 完成）。
- **不在发布流程里生成 demo**：上传的是提交进仓库、由 `forge demo --check`
  与 `forge bootstrap` 校验过的字节。生成逻辑仍然只有一份。
- 以后更新 demo：`pnpm demo && pnpm demo:publish`。

## 后果

- **好**：demo 有一个稳定 URL，且 URL 上的内容与仓库里的 `demo/` 逐字节一致。
- **好**：不碰 `.github/workflows/`，不产生第二个生成器；`forge demo --check`
  仍然是唯一的漂移判据。
- **代价**：发布内容在另一条分支上，主分支看不到部署历史；更新需要记住跑
  `pnpm demo:publish`（脚本与 README 都写了）。
- **残余风险**：social preview 图片与 30 秒 GIF 仍然需要人上传 / 录制；
  本 ADR 只解决"页面能公开访问"，不解决"素材已经录好"。
