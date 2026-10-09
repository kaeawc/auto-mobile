#!/usr/bin/env bats
# bats file_tags=parallel-within-file

SCRIPT="scripts/ios/check-ctrl-proxy-xcodegen-drift.sh"

setup() {
  STUB_HOME="$(mktemp -d)"
  mkdir -p "$STUB_HOME/bin"
  # A skewed XcodeGen: the wrapper must skip rather than generate with it.
  cat > "$STUB_HOME/bin/xcodegen" <<'STUB'
#!/usr/bin/env bash
echo "Version: 0.0.1"
STUB
  chmod +x "$STUB_HOME/bin/xcodegen"
}

teardown() {
  rm -rf "$STUB_HOME"
}

@test "skips when ios/control-proxy is unchanged against the base" {
  run env HOME="$STUB_HOME" PATH="$STUB_HOME/bin:$PATH" CTRL_PROXY_XCODEGEN_BASE_REF=HEAD bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP: ios/control-proxy is unchanged"* ]]
}

@test "skips with an install hint when the pinned XcodeGen is unavailable" {
  run env HOME="$STUB_HOME" PATH="$STUB_HOME/bin:$PATH" CTRL_PROXY_XCODEGEN_FORCE=1 bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"SKIP: XcodeGen "* ]]
  [[ "$output" == *"install-xcodegen.sh"* ]]
}

@test "checks (does not skip) when the base ref cannot be resolved" {
  run env HOME="$STUB_HOME" PATH="$STUB_HOME/bin:$PATH" CTRL_PROXY_XCODEGEN_BASE_REF=refs/nope/missing bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" != *"unchanged"* ]]
}

@test "the check is registered in Fast Validation" {
  run bash scripts/all_fast_validate_checks.sh --list
  [ "$status" -eq 0 ]
  [[ "$output" == *"ctrl-proxy-xcodegen-drift"* ]]
}
