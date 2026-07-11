#!/usr/bin/env bats
#
# Tests for scripts/deploy_website.sh
#
# Regression guard for #3656: the non-local deploy path must run
# `mkdocs gh-deploy` from inside the fresh clone (temp-clone), not the
# current (possibly dirty) working tree. Previously the clone was created
# and immediately deleted with nothing done inside it, so gh-deploy
# published whatever local state was in the working directory.

SCRIPT="scripts/deploy_website.sh"

setup() {
  ABS_SCRIPT="$(cd "$(dirname "$SCRIPT")" && pwd)/$(basename "$SCRIPT")"
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"

  # The "working tree" the script is invoked from — give it the same files
  # so a buggy (in-place) deploy would still succeed and be detectable only
  # by *where* mkdocs runs.
  mkdir -p "$WORK_DIR/docs" "$WORK_DIR/.github"
  : > "$WORK_DIR/CHANGELOG.md"
  : > "$WORK_DIR/.github/CONTRIBUTING.md"

  # Stub git: `clone <repo> <dir>` materializes <dir> with the same layout.
  cat > "$STUB_DIR/git" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "clone" ]; then
  dir="${3:?clone target}"
  mkdir -p "$dir/docs" "$dir/.github"
  : > "$dir/CHANGELOG.md"
  : > "$dir/.github/CONTRIBUTING.md"
fi
exit 0
EOF

  # Stub mkdocs: record the working directory gh-deploy runs from.
  cat > "$STUB_DIR/mkdocs" <<'EOF'
#!/usr/bin/env bash
echo "$PWD" > "$MKDOCS_CWD_FILE"
exit 0
EOF
  chmod +x "$STUB_DIR/git" "$STUB_DIR/mkdocs"
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
}

@test "gh-deploy runs from inside the fresh clone, not the working tree" {
  cd "$WORK_DIR"
  run env PATH="$STUB_DIR:$PATH" MKDOCS_CWD_FILE="$WORK_DIR/mkdocs_cwd.txt" \
    bash "$ABS_SCRIPT"
  [ "$status" -eq 0 ]

  [ -f "$WORK_DIR/mkdocs_cwd.txt" ]
  local deploy_cwd
  deploy_cwd="$(cat "$WORK_DIR/mkdocs_cwd.txt")"
  # Must have deployed from within temp-clone.
  [[ "$deploy_cwd" == *"/temp-clone" ]]
  # And the temp clone must be cleaned up afterward.
  [ ! -d "$WORK_DIR/temp-clone" ]
}
