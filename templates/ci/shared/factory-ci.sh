#!/usr/bin/env bash
# The factory's CI jobs for CI systems whose definitions call one script (Jenkins, CircleCI, Bitbucket Pipelines):
#   bash .factory/ci/factory-ci.sh <job>
# Jobs: gate, lint, feature-verification, review-quorum, pr-check, retro, tracker, graphify-prune. (Demo videos are made
# on the machine that runs the pipeline, never in CI.)
# It installs the factory version .factory/factory.json pins (from its `source`), then runs the job. The CI system passes
# its own variables: the target branch (FACTORY_BASE, else the CI's own pull request variable, else origin's default
# branch), the pull request number (FACTORY_PR), and the secrets the job needs from its secret store: FACTORY_TOKEN
# (read access to a private factory), the code host token (host.token's variable), the tracker's variables
# (tracker.auth), and the agent's credential (ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN or OPENAI_API_KEY). The script
# never prints a secret.
set -euo pipefail
job="${1:?usage: factory-ci.sh <job>}"

base="${FACTORY_BASE:-${CHANGE_TARGET:-${BITBUCKET_PR_DESTINATION_BRANCH:-}}}"
if [ -z "$base" ]; then base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"; fi
base="${base:-main}"
pr="${FACTORY_PR:-${CHANGE_ID:-${BITBUCKET_PR_ID:-${CIRCLE_PULL_REQUEST##*/}}}}"
git fetch --quiet origin "+refs/heads/$base:refs/remotes/origin/$base" || true

if [ ! -f .factory/factory.json ]; then echo "The factory is not on this branch yet; nothing to do."; exit 0; fi
version=$(node -p "require('./.factory/factory.json').version")
source=$(node -p "require('./.factory/factory.json').source || ''")
if [ -z "$source" ]; then echo ".factory/factory.json has no \"source\" (the factory's git URL)"; exit 1; fi
dest="${FACTORY_INSTALL_DIR:-${TMPDIR:-/tmp}/ai-app-factory-$version}"
if [ ! -x "$dest/bin/factory.mjs" ] && [ ! -f "$dest/bin/factory.mjs" ]; then
  auth=()
  if [ -n "${FACTORY_TOKEN:-}" ]; then
    auth=(-c "http.extraHeader=AUTHORIZATION: basic $(printf '%s:%s' "${FACTORY_TOKEN_USER:-x-access-token}" "$FACTORY_TOKEN" | base64 | tr -d '\n')")
  fi
  rm -rf "$dest"
  git -c init.defaultBranch=factory init --quiet "$dest"
  if ! { git -C "$dest" "${auth[@]}" fetch --quiet --depth 1 "$source" "refs/tags/v$version" && git -C "$dest" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD; }; then
    echo "Could not fetch the factory v$version from $source (a private factory needs FACTORY_TOKEN; the tag v$version must exist)."
    exit 1
  fi
  if [ -f "$dest/package-lock.json" ]; then (cd "$dest" && npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error); fi
fi
factory() { node "$dest/bin/factory.mjs" "$@"; }

agent_cli() {
  cli="${PIPELINE_AGENT_CLI:-claude}"
  export CODEX_API_KEY="${CODEX_API_KEY:-${OPENAI_API_KEY:-}}"
  if [ -n "${PIPELINE_AGENT_CMD:-}" ]; then return 0; fi
  case "$cli" in
    claude) [ -n "${ANTHROPIC_API_KEY:-}" ] || { echo "PIPELINE_AGENT_CLI is claude but ANTHROPIC_API_KEY is not set; skipping."; return 1; }; npm i -g @anthropic-ai/claude-code >/dev/null ;;
    copilot) [ -n "${COPILOT_GITHUB_TOKEN:-}" ] || { echo "PIPELINE_AGENT_CLI is copilot but COPILOT_GITHUB_TOKEN is not set; skipping."; return 1; }; npm i -g @github/copilot >/dev/null ;;
    codex) [ -n "${CODEX_API_KEY:-}" ] || { echo "PIPELINE_AGENT_CLI is codex but OPENAI_API_KEY is not set; skipping."; return 1; }; npm i -g @openai/codex >/dev/null ;;
    *) echo "Unknown PIPELINE_AGENT_CLI '$cli'"; exit 1 ;;
  esac
}

toolchain() { if [ -f .factory/ci/toolchain.sh ]; then . .factory/ci/toolchain.sh; fi; }

case "$job" in
  gate)
    factory check
    factory models check
    if [ -d .factory/stack ]; then
      toolchain
      factory teststack validate
      if node -e "process.exit(require('./.factory/config.json').teststack?.commands?.drift ? 0 : 1)"; then factory teststack drift; fi
    fi
    ;;
  lint) toolchain; factory lint --base "origin/$base" ;;
  feature-verification) factory fv check --changed-from "origin/$base" ;;
  # The approvals a pull request needs (its approvals:N), from the target branch's copy of the factory's code, never the
  # pull request's own.
  review-quorum)
    if [ -z "$pr" ]; then echo "Not a pull request build: no quorum to check."; exit 0; fi
    git worktree add --quiet --detach "${TMPDIR:-/tmp}/factory-base" "origin/$base"
    (cd "${TMPDIR:-/tmp}/factory-base" && factory review-quorum "$pr")
    ;;
  pr-check)
    if [ -z "$pr" ]; then echo "The PR check needs a pull request (FACTORY_PR)."; exit 1; fi
    agent_cli || exit 0
    factory pr-check run --pr "$pr" --base "origin/$base" --push --json
    ;;
  retro) agent_cli || exit 0; factory retro run ;;
  tracker) factory automations ;;
  graphify-prune) bash "$dest/scripts/graphify-prune-cache.sh" --prune ;;
  *) echo "Unknown job '$job'"; exit 64 ;;
esac
