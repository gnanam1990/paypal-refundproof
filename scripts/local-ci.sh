#!/usr/bin/env bash
# Clean-checkout CI equivalent: clones the GitHub remote at an exact SHA into a fresh temp directory and
# runs the same steps as .github/workflows/ci.yml. Used because GitHub Actions is blocked by account billing.
# Usage: scripts/local-ci.sh <sha> [log-file]
set -uo pipefail
SHA="${1:?usage: local-ci.sh <sha> [log]}"
LOG="${2:-/dev/stdout}"
REMOTE="$(git config --get remote.origin.url)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/refundproof-ci.XXXXXX")"
STEPS=(
  "pnpm install --frozen-lockfile"
  "pnpm format:check"
  "pnpm lint"
  "pnpm typecheck"
  "pnpm test:unit"
  "pnpm test:unit"
  "pnpm secret-scan"
  "pnpm pack:check"
)
[ -n "${CI_EXTRA_STEPS:-}" ] && IFS=';' read -r -a EXTRA <<<"$CI_EXTRA_STEPS" && STEPS+=("${EXTRA[@]}")
{
  echo "local-ci sha=$SHA node=$(node -v) pnpm=$(pnpm -v) os=$(uname -sm)"
  git clone -q "$REMOTE" "$WORK/repo" && cd "$WORK/repo" && git checkout -q "$SHA" || exit 2
  echo "checked out $(git rev-parse HEAD) clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo no)"
  FAIL=0
  for s in "${STEPS[@]}"; do
    echo "::step $s"
    bash -c "$s" 2>&1 | tail -n 40
    rc=${PIPESTATUS[0]}
    echo "::exit $rc :: $s"
    [ "$rc" -ne 0 ] && FAIL=1
  done
  echo "local-ci result=$([ $FAIL -eq 0 ] && echo PASS || echo FAIL) sha=$SHA"
  rm -rf "$WORK"
  exit $FAIL
} >"$LOG" 2>&1
