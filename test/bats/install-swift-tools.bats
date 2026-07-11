#!/usr/bin/env bats
#
# Tests for install_manual() in scripts/swiftformat/install_swiftformat.sh
# and scripts/swiftlint/install_swiftlint.sh
#
# Regression guard for #3649: install_manual ran unzip/mv/chmod with no error
# checks and then `return 0` unconditionally, so a failed/404 download still
# reported "Installation completed successfully!". The download must use
# --fail and each step must be checked so a failure returns non-zero.

setup() {
  STUB_DIR="$(mktemp -d)"
  WORK_DIR="$(mktemp -d)"

  # Stub curl: with --fail/-f a 404 exits non-zero and writes nothing;
  # otherwise it "succeeds" and saves a bogus (non-zip) payload.
  cat > "$STUB_DIR/curl" <<'EOF'
#!/usr/bin/env bash
out=""; prev=""; has_fail=0
for a in "$@"; do
  case "$a" in -*f*) [[ "$a" != --* || "$a" == --fail ]] && has_fail=1 ;; esac
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
if [ "$has_fail" = "1" ]; then echo "curl: (22) 404 Not Found" >&2; exit 22; fi
[ -n "$out" ] && printf 'not a real zip' > "$out"
exit 0
EOF
  chmod +x "$STUB_DIR/curl"
}

teardown() {
  rm -rf "$STUB_DIR" "$WORK_DIR"
}

# $1 = script path, $2 = version-var name
assert_manual_fails_on_404() {
  local script="$1" ver_var="$2"
  local abs
  abs="$(cd "$(dirname "$script")" && pwd)/$(basename "$script")"

  run env HOME="$WORK_DIR" PATH="$STUB_DIR:$PATH" bash -c '
    eval "$(grep "^'"$ver_var"'=" "$1" || true)"
    eval "$(awk "/^install_manual\\(\\) \\{/{f=1} f{print} f&&/^\\}/{exit}" "$1")"
    detect_os() { echo macos; }
    command_exists() { [ "$1" = curl ]; }
    RED=""; GREEN=""; YELLOW=""; NC=""
    install_manual
  ' _ "$abs"

  [ "$status" -ne 0 ]
}

@test "swiftformat install_manual fails when the download 404s" {
  assert_manual_fails_on_404 scripts/swiftformat/install_swiftformat.sh SWIFTFORMAT_VERSION
}

@test "swiftlint install_manual fails when the download 404s" {
  assert_manual_fails_on_404 scripts/swiftlint/install_swiftlint.sh SWIFTLINT_VERSION
}
