#!/usr/bin/env bash
#
# observe-byte-breakdown.sh — measurement half of the MCP output-context
# reduction harness (issue #2755).
#
# Given an `observe`-result JSON (from the observe/homeScreen MCP tools) it
# prints a byte breakdown by top-level field and by viewHierarchy sub-key, plus
# a check for the gfxinfoRaw dump that performanceAudit embeds twice. This gives
# every later reduction a fixed before/after baseline to quantify against.
#
# Usage:
#   scripts/observe-byte-breakdown.sh <observe-result.json>
#   scripts/observe-byte-breakdown.sh -            # read JSON from stdin
#   cat result.json | scripts/observe-byte-breakdown.sh
#
# Byte counts use the UTF-8 byte length of each value's *compact* JSON
# serialization — a fast relative view of which fields dominate. Note the
# observe tool actually emits a larger pretty-printed form with `extras` keys
# stripped (stringifyToolResponse), so these numbers under-count the real wire
# size. For a cap-accurate byte+token measurement use the production formatter
# via test/fixtures/observe/observeFixture.ts (measureObserveBreakdown).

set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") <observe-result.json | ->" >&2
  echo "       cat result.json | $(basename "$0")" >&2
}

# Resolve input: explicit file arg, "-", or stdin when nothing is a TTY.
source_label=""
input_json=""

if [ "$#" -gt 1 ]; then
  usage
  exit 2
fi

if [ "$#" -eq 1 ] && [ "$1" != "-" ]; then
  source_label="$1"
  if [ ! -f "$1" ]; then
    echo "ERROR: file not found: $1" >&2
    exit 1
  fi
  input_json="$(cat -- "$1")"
else
  source_label="<stdin>"
  input_json="$(cat)"
fi

# Emptiness check via streaming grep, not shell pattern replacement. A
# `${var//[[:space:]]/}` over a large payload is pathologically slow in
# multibyte (UTF-8) locales and hangs on the committed fixture; grep is
# constant-memory and locale-safe. The herestring avoids a pipe so pipefail
# cannot misread grep's early exit.
if ! grep -q '[^[:space:]]' <<<"$input_json"; then
  echo "ERROR: no input provided" >&2
  usage
  exit 1
fi

if ! printf '%s' "$input_json" | jq empty >/dev/null 2>&1; then
  echo "ERROR: input is not valid JSON" >&2
  exit 1
fi

# The report walks the object with to_entries/has(), which error on non-object
# JSON (array/scalar/null). Reject those up front with a clean message instead
# of leaking a raw jq stack trace.
if [ "$(printf '%s' "$input_json" | jq -r 'type')" != "object" ]; then
  echo "ERROR: expected a JSON object observe result, got: $(printf '%s' "$input_json" | jq -r 'type')" >&2
  exit 1
fi

# Unwrap homeScreen/tool wrappers: if the payload nests the observe result under
# an object `.observation` and has no top-level viewHierarchy, drill into it.
# Guarding on `.observation | type == "object"` keeps the result an object so
# the report below never trips over a non-object inner value.
observe_json="$(printf '%s' "$input_json" | jq -c '
  if (has("observation") and (.observation | type == "object") and (has("viewHierarchy") | not))
  then .observation else . end
')"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
total_bytes="$(printf '%s' "$observe_json" | jq -r 'tojson | utf8bytelength')"

echo "== Observe byte breakdown: ${source_label} =="
echo "Total: ${total_bytes} bytes"
echo ""

# Per top-level field, sorted by descending byte count, with % of total.
echo "-- Top-level fields (bytes, % of total) --"
printf '%s' "$observe_json" | jq -r --argjson total "$total_bytes" '
  to_entries
  | map({ key: .key, bytes: (.value | tojson | utf8bytelength) })
  | sort_by(-.bytes)[]
  | "  \(.bytes|tostring|(" " * (8 - length)) + .)  \(if $total > 0 then (100 * .bytes / $total) else 0 end | . * 10 | round / 10)%  \(.key)"
'
echo ""

# Per viewHierarchy sub-key, sorted by descending byte count, with % of the
# viewHierarchy total.
echo "-- viewHierarchy sub-keys (bytes, % of viewHierarchy) --"
if [ "$(printf '%s' "$observe_json" | jq -r 'has("viewHierarchy") and (.viewHierarchy | type == "object")')" = "true" ]; then
  printf '%s' "$observe_json" | jq -r '
    .viewHierarchy as $vh
    | ($vh | tojson | utf8bytelength) as $vhTotal
    | $vh
    | to_entries
    | map({ key: .key, bytes: (.value | tojson | utf8bytelength) })
    | sort_by(-.bytes)[]
    | "  \(.bytes|tostring|(" " * (8 - length)) + .)  \(if $vhTotal > 0 then (100 * .bytes / $vhTotal) else 0 end | . * 10 | round / 10)%  \(.key)"
  '
else
  echo "  (no viewHierarchy)"
fi
echo ""

# Duplication check: performanceAudit stores the raw gfxinfo dump in
# metrics.gfxinfoRaw and inlines it again inside the diagnostics string.
echo "-- gfxinfo duplication (performanceAudit) --"
if [ "$(printf '%s' "$observe_json" | jq -r 'has("performanceAudit") and (.performanceAudit | type == "object")')" = "true" ]; then
  printf '%s' "$observe_json" | jq -r '
    # Coerce to strings so utf8bytelength / contains never crash on malformed
    # (non-string) values; null collapses to "" so absent fields read as 0 bytes.
    def asstr: if . == null then "" elif type == "string" then . else tojson end;
    .performanceAudit as $pa
    | (($pa.metrics // {}).gfxinfoRaw | asstr) as $raw
    | ($pa.diagnostics | asstr) as $diag
    # "embeds" is a substring test on the serialized strings: a true match means
    # diagnostics literally inlines the raw dump. A re-escaped copy would not match.
    | "  metrics.gfxinfoRaw: \($raw | utf8bytelength) bytes",
      "  diagnostics: \($diag | utf8bytelength) bytes\(if ($raw | length) > 0 and ($diag | contains($raw)) then " (embeds gfxinfoRaw)" else "" end)"
  '
else
  echo "  (no performanceAudit)"
fi
