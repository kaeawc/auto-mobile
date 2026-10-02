#!/usr/bin/env bats
#
# Tests for scripts/ios/validate-network-mock-debug-only.sh

SCRIPT="scripts/ios/validate-network-mock-debug-only.sh"

@test "network mock enforcement is guarded to debug builds" {
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"iOS network mock enforcement is DEBUG-only."* ]]
}

@test "both startLoading modifier orders pass only with a DEBUG guard" {
  local root="$BATS_TEST_TMPDIR/fixture"
  local network_dir="$root/ios/auto-mobile-sdk/Sources/AutoMobileSDK/Network"
  mkdir -p "$root/scripts/ios" "$network_dir"
  cp "$SCRIPT" "$root/scripts/ios/validate-network-mock-debug-only.sh"
  cat > "$network_dir/NetworkMockRuleStore.swift" <<'SWIFT'
#if DEBUG
final class NetworkMockRuleStore {}
#endif
SWIFT

  local modifiers
  for modifiers in "public override" "override public"; do
    cat > "$network_dir/AutoMobileNetwork.swift" <<SWIFT
$modifiers func startLoading() {
    #if DEBUG
    NetworkMockRuleStore.shared.findMatchingRule()
    #endif
    guard let mutableRequest = request else { return }
}
SWIFT
    run bash "$root/scripts/ios/validate-network-mock-debug-only.sh"
    [ "$status" -eq 0 ]
    [[ "$output" == *"iOS network mock enforcement is DEBUG-only."* ]]

    cat > "$network_dir/AutoMobileNetwork.swift" <<SWIFT
$modifiers func startLoading() {
    NetworkMockRuleStore.shared.findMatchingRule()
    guard let mutableRequest = request else { return }
}
SWIFT
    run bash "$root/scripts/ios/validate-network-mock-debug-only.sh"
    [ "$status" -eq 1 ]
    [[ "$output" == *"AutoMobileURLProtocol mock lookup must be guarded by #if DEBUG"* ]]
  done
}
