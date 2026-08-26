#!/usr/bin/env bats
#
# Tests for scripts/changelog/update_changelog_from_issues.sh
#
# Regression guard for #3657: the script must invoke `python3`, not bare
# `python`. On GitHub `ubuntu-latest` and modern macOS there is no
# `/usr/bin/python`, so a bare `python` invocation dies with
# "command not found" and aborts the release-prep job.

SCRIPT="scripts/changelog/update_changelog_from_issues.sh"

setup() {
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"

  # Poison bare `python` so that ANY use of it fails loudly and
  # deterministically, regardless of what the host has on PATH.
  cat > "$STUB_DIR/python" <<'EOF'
#!/usr/bin/env bash
echo "bare 'python' must not be used; use python3 (#3657)" >&2
exit 127
EOF

  # Make the real python3 reachable under our minimal PATH.
  ln -s "$(command -v python3)" "$STUB_DIR/python3"

  # Stub `gh`: emit one @json issue line (the shape the script parses).
  cat > "$STUB_DIR/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"number":1,"title":"Fix a thing","html_url":"https://example.com/1","labels":[{"name":"bug"}]}'
EOF

  # Stub `git`: `fetch` succeeds; `show` returns a fixed ISO date.
  cat > "$STUB_DIR/git" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  fetch) exit 0 ;;
  show)  echo "2020-01-01T00:00:00Z" ;;
  *)     exit 0 ;;
esac
EOF

  chmod +x "$STUB_DIR"/python "$STUB_DIR"/gh "$STUB_DIR"/git
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
}

@test "generates a changelog entry using python3 (bare python poisoned)" {
  run env \
    PATH="$STUB_DIR:/usr/bin:/bin" \
    GITHUB_REPOSITORY="kaeawc/auto-mobile" \
    CURRENT_TAG="v9.9.9" \
    SINCE_TAG="v9.9.8" \
    CHANGELOG_FILE="$WORK_DIR/CHANGELOG.md" \
    bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" != *"must not be used"* ]]
  grep -q '## \[v9.9.9\]' "$WORK_DIR/CHANGELOG.md"
  grep -q 'Fix a thing' "$WORK_DIR/CHANGELOG.md"
}

@test "source never invokes bare python" {
  run grep -nE '(^|[^0-9a-zA-Z_.])python([^3a-zA-Z]|$)' "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "emits oxfmt-clean markdown: a blank line follows every heading (#5743)" {
  # The release commit carries [skip ci], so unformatted generator output lands
  # on main unobserved and reddens Check Formatting for the next contributor.
  run env \
    PATH="$STUB_DIR:/usr/bin:/bin" \
    GITHUB_REPOSITORY="kaeawc/auto-mobile" \
    CURRENT_TAG="v9.9.9" \
    SINCE_TAG="v9.9.8" \
    CHANGELOG_FILE="$WORK_DIR/CHANGELOG.md" \
    bash "$SCRIPT"

  [ "$status" -eq 0 ]

  run awk '/^#/ { heading = NR; next } heading && NR == heading + 1 && $0 != "" { print NR": "$0; found = 1 } END { exit found ? 0 : 1 }' \
    "$WORK_DIR/CHANGELOG.md"
  [ "$status" -ne 0 ]
}

@test "keeps existing entries blank-line separated when prepending (#5743)" {
  cat > "$WORK_DIR/CHANGELOG.md" <<'PRIOR'
# Changelog

## [v9.9.8] - 2020-01-01

### Fixed

- An older thing ([#0](https://example.com/0))
PRIOR

  run env \
    PATH="$STUB_DIR:/usr/bin:/bin" \
    GITHUB_REPOSITORY="kaeawc/auto-mobile" \
    CURRENT_TAG="v9.9.9" \
    SINCE_TAG="v9.9.8" \
    CHANGELOG_FILE="$WORK_DIR/CHANGELOG.md" \
    bash "$SCRIPT"

  [ "$status" -eq 0 ]
  grep -q '## \[v9.9.8\]' "$WORK_DIR/CHANGELOG.md"

  run awk '/^#/ { heading = NR; next } heading && NR == heading + 1 && $0 != "" { found = 1 } END { exit found ? 0 : 1 }' \
    "$WORK_DIR/CHANGELOG.md"
  [ "$status" -ne 0 ]
}
