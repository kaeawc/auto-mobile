#!/usr/bin/env bash
# Summarize Bun diagnostics before or after (fail), without copying source excerpts.
# At most 10 diagnostic lines + (fail) + timeout reason per failure. Reserve one
# of 200 content lines for the final Ran summary; the truncation marker is extra.
set -euo pipefail

awk '
  function emit(line) {
    selected++
    if (selected <= 199) print line
    else truncated++
  }
  function flush( i) {
    for (i = 1; i <= context_count; i++) emit(context[i])
    context_count = 0
    in_error = 0
    saw_frame = 0
  }
  /^Ran [0-9]+ tests?/ {
    flush()
    summary = $0
    emit($0)
    summary_printed = (selected <= 199)
    next
  }
  /\(fail\)/ {
    flush()
    emit($0)
    next
  }
  /this test timed out after/ {
    emit($0)
    next
  }
  /^error:/ {
    flush()
    in_error = 1
    context[++context_count] = $0
    next
  }
  /^\(pass\)|^bun test |^[^[:space:]].*\.(ts|tsx|js):$/ {
    flush()
    next
  }
  in_error {
    # Keep the first eight context lines and the first file:line stack frame,
    # even when a long Expected/Received value pushes that frame further down.
    if ($0 ~ /^[[:space:]]+at .*:[0-9]+(:[0-9]+)?\)?$/) {
      if (!saw_frame) {
        context[++context_count] = $0
        saw_frame = 1
      }
    } else if (!saw_frame && context_count < 9) {
      context[++context_count] = $0
    }
  }
  END {
    flush()
    if (summary != "" && !summary_printed) truncated--
    if (truncated) printf "... %d more lines truncated\n", truncated
    if (summary != "" && !summary_printed) print summary
  }
' "${1:--}"
