#!/usr/bin/env bats
#
# Tests for scripts/github/docs_changed_since_last_deploy.sh
#
# The docs deploy (.github/workflows/docs.yml) runs nightly and skips the
# LFS-backed checkout + MkDocs build + Pages deploy when no docs source changed
# since the last successful deploy. This guards that decision logic:
#   - workflow_dispatch always republishes
#   - no prior successful deploy republishes
#   - an unreachable last-deployed commit republishes (safe fallback)
#   - a docs-path change since the last deploy republishes
#   - no docs-path change since the last deploy skips

SCRIPT="scripts/github/docs_changed_since_last_deploy.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"

  # Hermetic git config so developer-global hooks/filters don't interfere.
  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null

  REPO="$(mktemp -d)"
  STUB_DIR="$(mktemp -d)"
  OUT_FILE="$(mktemp)"
  export GITHUB_OUTPUT="$OUT_FILE"

  # Stub `gh`: emit whatever headSha the test placed in GH_STUB_HEADSHA. An
  # empty value models "no prior successful run".
  cat > "$STUB_DIR/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s' "${GH_STUB_HEADSHA:-}"
EOF
  chmod +x "$STUB_DIR/gh"
  export PATH="$STUB_DIR:$PATH"

  cd "$REPO"
  git init -q
  git config user.email t@t.t
  git config user.name t
  git config commit.gpgsign false
  mkdir -p docs
  echo "hello" > docs/index.md
  git add -A
  git commit -qm "initial docs"
  BASE_SHA="$(git rev-parse HEAD)"

  # Defaults: scheduled event (not a manual dispatch), no repo hint needed.
  export GITHUB_EVENT_NAME="schedule"
  unset GITHUB_REPOSITORY || true
}

teardown() {
  rm -rf "$REPO" "$STUB_DIR" "$OUT_FILE"
}

changed_value() {
  # Last `changed=` line wins; the script writes exactly one.
  grep -E '^changed=' "$GITHUB_OUTPUT" | tail -n1 | cut -d= -f2
}

@test "workflow_dispatch always republishes" {
  export GITHUB_EVENT_NAME="workflow_dispatch"
  export GH_STUB_HEADSHA="$BASE_SHA"   # even with a valid last deploy
  run bash "$ABS_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(changed_value)" = "true" ]
}

@test "no prior successful deploy republishes" {
  export GH_STUB_HEADSHA=""            # gh returns nothing
  run bash "$ABS_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(changed_value)" = "true" ]
}

@test "unreachable last-deployed commit republishes" {
  export GH_STUB_HEADSHA="0000000000000000000000000000000000000000"
  run bash "$ABS_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(changed_value)" = "true" ]
}

@test "no docs change since last deploy skips" {
  # Advance HEAD with a NON-docs change; diff over docs paths is empty.
  echo "unrelated" > src.txt
  git add -A
  git commit -qm "non-docs change"
  export GH_STUB_HEADSHA="$BASE_SHA"
  run bash "$ABS_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(changed_value)" = "false" ]
}

@test "docs change since last deploy republishes" {
  echo "new page" > docs/new.md
  git add -A
  git commit -qm "add docs page"
  export GH_STUB_HEADSHA="$BASE_SHA"
  run bash "$ABS_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(changed_value)" = "true" ]
}

@test "mkdocs.yml change since last deploy republishes" {
  echo "site_name: x" > mkdocs.yml
  git add -A
  git commit -qm "edit mkdocs config"
  export GH_STUB_HEADSHA="$BASE_SHA"
  run bash "$ABS_SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(changed_value)" = "true" ]
}
