#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NETWORK_FILE="${ROOT_DIR}/ios/auto-mobile-sdk/Sources/AutoMobileSDK/Network/AutoMobileNetwork.swift"
STORE_FILE="${ROOT_DIR}/ios/auto-mobile-sdk/Sources/AutoMobileSDK/Network/NetworkMockRuleStore.swift"

fail() {
  echo "error: $*" >&2
  exit 1
}

line_number() {
  local pattern="$1"
  local file="$2"
  awk -v pattern="$pattern" '$0 ~ pattern { print NR; exit }' "$file"
}

first_significant_line="$(
  awk '/^[[:space:]]*[^[:space:]]/ { sub(/^[[:space:]]*/, ""); print; exit }' "$STORE_FILE"
)"
last_significant_line="$(
  awk '/^[[:space:]]*[^[:space:]]/ { line = $0 } END { sub(/^[[:space:]]*/, "", line); print line }' "$STORE_FILE"
)"

[[ "$first_significant_line" == "#if DEBUG" ]] ||
  fail "NetworkMockRuleStore.swift must compile only inside #if DEBUG"

[[ "$last_significant_line" == "#endif" ]] ||
  fail "NetworkMockRuleStore.swift must close its file-level #if DEBUG guard"

start_loading_line="$(line_number 'public override func startLoading\(\)' "$NETWORK_FILE")"
mock_lookup_line="$(line_number 'NetworkMockRuleStore\.shared\.findMatchingRule' "$NETWORK_FILE")"
forwarding_line="$(line_number 'guard let mutableRequest' "$NETWORK_FILE")"

[[ -n "$start_loading_line" && -n "$mock_lookup_line" && -n "$forwarding_line" ]] ||
  fail "expected startLoading, mock lookup, and forwarding fallback in AutoMobileNetwork.swift"

debug_guard_line="$(
  awk -v start="$start_loading_line" -v lookup="$mock_lookup_line" \
    'NR > start && NR < lookup && /^[[:space:]]*#if DEBUG[[:space:]]*$/ { line = NR } END { if (line) print line }' \
    "$NETWORK_FILE"
)"
endif_line="$(
  awk -v lookup="$mock_lookup_line" -v fallback="$forwarding_line" \
    'NR > lookup && NR < fallback && /^[[:space:]]*#endif[[:space:]]*$/ { print NR; exit }' \
    "$NETWORK_FILE"
)"

[[ -n "$debug_guard_line" ]] ||
  fail "AutoMobileURLProtocol mock lookup must be guarded by #if DEBUG"

[[ -n "$endif_line" ]] ||
  fail "AutoMobileURLProtocol mock lookup must close #if DEBUG before forwarding"

echo "iOS network mock enforcement is DEBUG-only."
