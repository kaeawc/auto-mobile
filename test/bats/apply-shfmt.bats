#!/usr/bin/env bats
#
# Tests for scripts/shellcheck/apply_shfmt.sh
#
# Regression guard for #3643: shfmt's exit status must be checked. The old code
# inferred failure only by grepping shfmt's output for keywords
# (error|Error|…|FAILED); shfmt parse errors ("reached EOF without matching …")
# contain none of them, so an unparseable file was silently skipped, the files
# were still git-added, and the script reported success — the same silent-failure
# class apply_ktfmt.sh fixed via PIPESTATUS.
#
# Source-scan assertions (a behavioral run needs a git repo + file-selection lib
# + shfmt; the fix is a small, self-contained status check).

SCRIPT="scripts/shellcheck/apply_shfmt.sh"

# Non-comment source lines only.
code() { grep -vE '^\s*#' "$SCRIPT"; }

@test "shfmt exit status is captured" {
  code | grep -qE 'shfmt_status=\$\?'
}

@test "a non-zero shfmt exit is treated as an error (not just keyword matches)" {
  code | grep -qE 'shfmt_status[[:space:]]*-ne[[:space:]]*0'
}
