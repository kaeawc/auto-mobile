#!/usr/bin/env bats

# Regression coverage for #3982: a successful Homebrew install is not enough
# for tools whose output can rewrite committed files. The shared installer must
# fall back to the pinned release when Homebrew resolves a different version.

setup() {
  REPO_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  STUB_DIR="$(mktemp -d)"
}

teardown() {
  rm -rf "$STUB_DIR"
}

@test "brew success with a skewed version falls back to the manual installer" {
  # shellcheck disable=SC2016 # Variables expand in the child bash process.
  run env CALL_LOG="$STUB_DIR/calls" bash -c '
    source "$1/scripts/lib/tool-install.sh"
    installed=skewed
    command_exists() { [[ "$1" == brew ]]; }
    brew() { printf "%s\\n" brew >> "$CALL_LOG"; }
    manual() { installed=pinned; printf "%s\\n" manual >> "$CALL_LOG"; }
    is_pinned() { [[ "$installed" == pinned ]]; }
    install_via_brew_or_manual Formatter formatter manual is_pinned
  ' _ "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_DIR/calls")" = $'brew\nmanual' ]
}

@test "a matching Homebrew version does not invoke the manual installer" {
  # shellcheck disable=SC2016 # Variables expand in the child bash process.
  run env CALL_LOG="$STUB_DIR/calls" bash -c '
    source "$1/scripts/lib/tool-install.sh"
    command_exists() { [[ "$1" == brew ]]; }
    brew() { printf "%s\\n" brew >> "$CALL_LOG"; }
    manual() { printf "%s\\n" manual >> "$CALL_LOG"; }
    is_pinned() { return 0; }
    install_via_brew_or_manual Formatter formatter manual is_pinned
  ' _ "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [ "$(cat "$STUB_DIR/calls")" = "brew" ]
}

@test "pinned installers pass a version check to the shared macOS helper" {
  run grep -E 'install_via_brew_or_manual.*is_pinned_swiftlint_version' "$REPO_ROOT/scripts/swiftlint/install_swiftlint.sh"
  [ "$status" -eq 0 ]

  run grep -E 'install_via_brew_or_manual.*is_pinned_swiftformat_version' "$REPO_ROOT/scripts/swiftformat/install_swiftformat.sh"
  [ "$status" -eq 0 ]

  run grep -E 'install_via_brew_or_manual.*is_pinned_shfmt_version' "$REPO_ROOT/scripts/shellcheck/install_shfmt.sh"
  [ "$status" -eq 0 ]
}

@test "formatter callers make a manual install visible after the installer exits" {
  for script in scripts/swiftlint/apply_swiftlint.sh scripts/swiftlint/validate_swiftlint.sh scripts/swiftformat/apply_swiftformat.sh scripts/swiftformat/validate_swiftformat.sh scripts/shellcheck/apply_shfmt.sh; do
    # shellcheck disable=SC2016 # Search for the literal PATH expansion.
    run grep -F 'export PATH="$HOME/.local/bin:$PATH"' "$REPO_ROOT/$script"
    [ "$status" -eq 0 ]
  done
}

@test "write paths reject a formatter whose version differs from the pin" {
  cat > "$STUB_DIR/swiftlint" <<'EOF'
#!/usr/bin/env bash
echo 0.0.0
EOF
  cat > "$STUB_DIR/swiftformat" <<'EOF'
#!/usr/bin/env bash
echo 0.0.0
EOF
  cat > "$STUB_DIR/shfmt" <<'EOF'
#!/usr/bin/env bash
echo v0.0.0
EOF
  chmod +x "$STUB_DIR/swiftlint" "$STUB_DIR/swiftformat" "$STUB_DIR/shfmt"

  for script in scripts/swiftlint/apply_swiftlint.sh scripts/swiftlint/validate_swiftlint.sh scripts/swiftformat/apply_swiftformat.sh scripts/swiftformat/validate_swiftformat.sh scripts/shellcheck/apply_shfmt.sh; do
    # Formatter scripts prepend $HOME/.local/bin to PATH, so isolate HOME to
    # ensure the deliberately mismatched stub is the executable under test.
    run env HOME="$STUB_DIR/home" PATH="$STUB_DIR:$PATH" bash "$REPO_ROOT/$script"
    [ "$status" -ne 0 ]
    [[ "$output" == *"version mismatch"* ]]
  done
}

@test "version gates reject prerelease formatter builds" {
  cat > "$STUB_DIR/swiftlint" <<'EOF'
#!/usr/bin/env bash
echo 0.57.0-rc.1
EOF
  cat > "$STUB_DIR/swiftformat" <<'EOF'
#!/usr/bin/env bash
echo 0.54.6-beta.1
EOF
  cat > "$STUB_DIR/shfmt" <<'EOF'
#!/usr/bin/env bash
echo v3.10.0-rc.1
EOF
  chmod +x "$STUB_DIR/swiftlint" "$STUB_DIR/swiftformat" "$STUB_DIR/shfmt"

  for version_file in scripts/swiftlint/swiftlint_version.sh scripts/swiftformat/swiftformat_version.sh scripts/shellcheck/shfmt_version.sh; do
    # shellcheck disable=SC2016 # The function name is assembled in child bash.
    run env PATH="$STUB_DIR:$PATH" bash -c 'source "$1"; require_pinned_"${2}"_version' _ "$REPO_ROOT/$version_file" "$(basename "$version_file" _version.sh)"
    [ "$status" -ne 0 ]
    [[ "$output" == *"version mismatch"* ]]
  done
}
