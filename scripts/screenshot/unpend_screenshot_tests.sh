#!/usr/bin/env bash
#
# unpend_screenshot_tests.sh — drop the `pending = true` argument from
# `screenshotTest(...)` calls so a recorded baseline turns a placeholder test
# into an active verification check.
#
# A screenshot test is authored `screenshotTest("name", pending = true) { … }`
# while its baseline PNG does not exist yet: pending tests are skipped in verify
# mode (so CI can't fail on the missing baseline) but still run in record mode.
# Once the record job (see .github/workflows/record-screenshot-baselines.yml) has
# written the baselines, this script removes the `pending = true` argument in the
# same change, so the test becomes a real check. It is idempotent — running it on
# an already-un-pended file is a no-op — and edits files in place.
#
# Usage: unpend_screenshot_tests.sh <file.kt> [<file.kt> ...]

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <file.kt> [<file.kt> ...]" >&2
  exit 2
fi

changed=0
for file in "$@"; do
  if [[ ! -f "$file" ]]; then
    echo "error: not a file: $file" >&2
    exit 1
  fi

  backup="$file.unpend.bak"
  cp "$file" "$backup"
  # Remove the `pending = true` named argument in either comma position:
  #   screenshotTest("n", pending = true)  -> screenshotTest("n")
  #   screenshotTest(pending = true, "n")  -> screenshotTest("n")
  # -0 slurps the whole file so a match can span the reformatted line breaks
  # ktfmt may introduce; whitespace around `=` and the comma is tolerated. Only
  # `= true` is removed; `pending = false` (if ever used) is left alone.
  perl -0pi -e 's/\s*,\s*pending\s*=\s*true//g; s/pending\s*=\s*true\s*,\s*//g' "$file"

  if cmp -s "$file" "$backup"; then
    echo "no pending tests: $file"
  else
    echo "un-pended: $file"
    changed=1
  fi
  rm -f "$backup"
done

if [[ "$changed" -eq 0 ]]; then
  echo "No screenshot tests were pending."
fi
