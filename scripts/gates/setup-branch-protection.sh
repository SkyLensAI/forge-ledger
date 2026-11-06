#!/usr/bin/env bash
# 闸门 3 + 4 的服务端配置：required status check + branch rule。
#
# 为什么必须有这一步：本地钩子（闸门 1/2）全部可被绕过，服务端这两条才是
# 真正拦得住合并的地方。仓库还没有 remote 时它无法生效 —— 这一点记在
# docs/gates/bypass-matrix.md，不许假装已经装好了。
#
# 用法：
#   scripts/gates/setup-branch-protection.sh                 # 默认：1 个 approve
#   scripts/gates/setup-branch-protection.sh --approvals 0   # 单人模式：CI 绿即可合并
#   scripts/gates/setup-branch-protection.sh --reviewer alice --environment-reviewer alice
#
# 需要：gh 已登录，且对仓库有 admin 权限。
set -euo pipefail

BRANCH="main"
APPROVALS=1
REVIEWER=""
ENV_REVIEWER=""
REQUIRED_CHECK="gates"
ENVIRONMENT="release"

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --approvals) APPROVALS="$2"; shift 2 ;;
    --reviewer) REVIEWER="$2"; shift 2 ;;
    --environment-reviewer) ENV_REVIEWER="$2"; shift 2 ;;
    --required-check) REQUIRED_CHECK="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "✗ 找不到 gh CLI。装好并 gh auth login 之后再跑。" >&2
  exit 1
fi

REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
if [ -z "$REPO" ]; then
  echo "✗ 当前目录没有可用的 GitHub remote（gh repo view 失败）。" >&2
  echo "  闸门 3/4 需要 remote 才能生效；先建远程仓库，再跑本脚本。" >&2
  exit 1
fi
echo "→ 仓库：$REPO，分支：$BRANCH，required check：$REQUIRED_CHECK"

# ── 闸门 3 + 4：分支保护 ───────────────────────────────────────────────────
# enforce_admins=true 是关键：管理员豁免是文档里点名的绕过方式之一。
PROTECTION=$(cat <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ["$REQUIRED_CHECK"] },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": $APPROVALS,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true,
  "required_conversation_resolution": true
}
JSON
)

echo "$PROTECTION" | gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" \
  -H "Accept: application/vnd.github+json" --input - >/dev/null
echo "✓ 分支保护已生效（enforce_admins=true，force push / 删除分支均已禁止）"

if [ "$APPROVALS" = "0" ]; then
  echo "  ⚠ approvals=0：PR 只要 CI 绿就能自己合。这是单人模式的取舍，记在 bypass-matrix 里。"
fi

if [ -n "$REVIEWER" ]; then
  echo "→ 配 CODEOWNERS reviewer（$REVIEWER）"
  gh api -X PATCH "repos/$REPO/branches/$BRANCH/protection/required_pull_request_reviews" \
    -H "Accept: application/vnd.github+json" \
    -f "dismiss_stale_reviews=true" >/dev/null
  echo "  （reviewer 名单请在仓库设置里确认；API 对个人仓库的 team 限制较多）"
fi

# ── 闸门 5：发布环境的人工审批 ─────────────────────────────────────────────
if [ -n "$ENV_REVIEWER" ]; then
  USER_ID=$(gh api "users/$ENV_REVIEWER" --jq .id)
  gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" \
    -H "Accept: application/vnd.github+json" \
    -F "reviewers[][type]=User" -F "reviewers[][id]=$USER_ID" >/dev/null
  echo "✓ 发布环境 $ENVIRONMENT 已配置 required reviewer：$ENV_REVIEWER"
else
  echo "⚠ 未配置发布环境的 required reviewer：闸门 5 目前只有 CI 判定，没有人工审批。"
  echo "  补配：scripts/gates/setup-branch-protection.sh --environment-reviewer <login>"
fi

echo
echo "完成。现在验证一遍："
echo "  1) 开一个故意写错的 PR（删掉一处校验），确认 required check 变红且无法合并"
echo "  2) gh api repos/$REPO/branches/$BRANCH/protection --jq '.enforce_admins.enabled'"
