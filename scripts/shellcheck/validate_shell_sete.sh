#!/usr/bin/env bash
#
# Scoped `set -e`-suppressed gate for scripts/**/*.sh (follow-up to the bash bug
# hunt, #3637-#3658).
#
# The optional ShellCheck `check-set-e-suppressed` check (SC2310/SC2311) flags a
# function or pipeline invoked in a condition where `set -e` is silently
# disabled — the class of masked-failure bug behind #3637 and #3640. A plain
# gate cannot be turned on green: ~392 mostly-benign instances already exist
# (`if some_check; then` is idiomatic). So we snapshot the CURRENT set into a
# committed baseline (scripts/shellcheck/sete-baseline.txt) and fail only when a
# change introduces a NEW finding. The baseline is a one-way ratchet meant to be
# burned down over time:
#   * A NEW finding fails the gate; recording it needs `--update`, which REFUSES
#     to write a larger baseline without `--allow-grow`.
#   * Fixing findings keeps the gate green and nudges you to `--update` so the
#     baseline shrinks.
#
# Signatures are keyed by "path: <severity>: <message> [SCxxxx]" with the
# ":line:col:" stripped, so unrelated edits that shift line numbers don't churn
# the baseline.
#
# Usage:
#   scripts/shellcheck/validate_shell_sete.sh                    # check (CI gate)
#   scripts/shellcheck/validate_shell_sete.sh --update           # regenerate (refuses to grow)
#   scripts/shellcheck/validate_shell_sete.sh --update --allow-grow
set -euo pipefail

# Byte-wise, locale-independent sort/compare so `comm` sees identical collation
# on macOS dev and ubuntu CI.
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# SHELL_SETE_BASELINE overrides the baseline path (BATS tests never touch the
# committed one).
BASELINE="${SHELL_SETE_BASELINE:-$ROOT/scripts/shellcheck/sete-baseline.txt}"
cd "$ROOT"

MODE="check"
ALLOW_GROW="false"
for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    --allow-grow) ALLOW_GROW="true" ;;
    *) echo "Unknown argument: $arg (expected --update and/or --allow-grow)" >&2; exit 2 ;;
  esac
done
if [[ "$ALLOW_GROW" == "true" && "$MODE" != "update" ]]; then
  echo "--allow-grow is only valid with --update" >&2
  exit 2
fi

# SHELL_SETE_CMD overrides the shellcheck invocation — used by the BATS tests to
# inject canned output. It is `eval`ed, so treat it as TRUSTED input only.
run_check() {
  if [[ -n "${SHELL_SETE_CMD:-}" ]]; then
    eval "$SHELL_SETE_CMD" 2>&1
  else
    find scripts -name '*.sh' -type f -print0 \
      | sort -z \
      | xargs -0 shellcheck --enable=check-set-e-suppressed -f gcc 2>&1 || true
  fi
}

# Reduce raw shellcheck gcc output to a sorted multiset of stable signatures:
# keep only SC2310/SC2311 lines and strip the ":line:col:" location.
normalize() {
  { grep -E ' \[SC231[01]\]$' || true; } \
    | sed -E 's/:[0-9]+:[0-9]+:/:/' \
    | sort
}

sc_version() { shellcheck --version 2>/dev/null | awk '/version:/{print $2}' || true; }

current="$(run_check | normalize)"
current="$(printf '%s\n' "$current" | grep -v '^$' || true)"

if [[ "$MODE" == "update" ]]; then
  new_count=$(printf '%s\n' "$current" | grep -c . || true)
  if [[ -f "$BASELINE" ]]; then
    old_count=$(grep -vE '^#' "$BASELINE" | grep -c . || true)
    if [[ "$new_count" -gt "$old_count" && "$ALLOW_GROW" != "true" ]]; then
      echo "Refusing to grow the baseline (${old_count} → ${new_count}) without --allow-grow." >&2
      echo "A new set -e-suppressed finding was introduced; fix it instead." >&2
      exit 1
    fi
  fi
  ver="$(sc_version)"
  [[ -n "$ver" ]] || ver="unknown"
  {
    echo "# shellcheck set -e-suppressed (SC2310/SC2311) baseline — burn down over time."
    echo "# Regenerate with: scripts/shellcheck/validate_shell_sete.sh --update"
    echo "# generated-with: shellcheck ${ver}"
    printf '%s\n' "$current"
  } > "$BASELINE"
  echo "Wrote ${new_count} baselined finding(s) to ${BASELINE}"
  exit 0
fi

# ---- check mode ----
if [[ ! -f "$BASELINE" ]]; then
  echo "Missing baseline ${BASELINE}. Run: scripts/shellcheck/validate_shell_sete.sh --update" >&2
  exit 1
fi
baseline="$(grep -vE '^#' "$BASELINE" | grep -v '^$' | sort || true)"

new_findings="$(comm -23 <(printf '%s\n' "$current") <(printf '%s\n' "$baseline") | grep -v '^$' || true)"
if [[ -n "$new_findings" ]]; then
  echo "New set -e-suppressed finding(s) not in the baseline:" >&2
  printf '%s\n' "$new_findings" >&2
  echo "" >&2
  echo "Invoke the function/pipeline separately so a failure still exits (see #3637/#3640)," >&2
  echo "or, if intentional, run: scripts/shellcheck/validate_shell_sete.sh --update" >&2
  exit 1
fi

removed="$(comm -13 <(printf '%s\n' "$current") <(printf '%s\n' "$baseline") | grep -c . || true)"
if [[ "$removed" -gt 0 ]]; then
  echo "Note: ${removed} baselined finding(s) are now fixed — run --update to shrink the baseline."
fi
echo "No new set -e-suppressed findings."
