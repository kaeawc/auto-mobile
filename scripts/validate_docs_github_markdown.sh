#!/usr/bin/env bash
#
# Keep docs/ Markdown readable on github.com as well as on the MkDocs site.
#
# GitHub renders MkDocs-only syntax as literal text (or, once indented, as code
# blocks), and it strips <style>/<script>. Reject those constructs and point at
# the GitHub-compatible replacement:
#
#   === "Tab"          -> plain headings
#   !!! note           -> > [!NOTE] (github_alerts.py hook renders it on the site)
#   ??? note           -> <details markdown="1"><summary>…</summary> … </details>
#   { .class }, { k=v } -> <div class="class" markdown> … </div> / HTML attributes
#   --8<-- snippets    -> a link, or inline the content
#   <style>/<script>   -> docs/assets/{stylesheets,javascripts} via mkdocs.yml
#
# Fenced code blocks and inline code spans are ignored.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCS_DIR="${DOCS_DIR:-${ROOT_DIR}/docs}"

# shellcheck disable=SC2016 # awk program, not shell expansions.
violations="$(
  find "$DOCS_DIR" -name '*.md' -type f -print0 | sort -z | xargs -0 awk '
    FNR == 1 { fence = "" }
    # A fence closes only on the same character, at least as long as its
    # opener, with nothing after it (CommonMark), so a shorter fence line
    # inside a longer fence is content, not a close.
    match($0, /^[[:space:]]*(```+|~~~+)/) {
      run = substr($0, RSTART, RLENGTH)
      sub(/^[[:space:]]*/, "", run)
      rest = substr($0, RSTART + RLENGTH)
      if (fence == "") { fence = run; next }
      if (substr(run, 1, 1) == substr(fence, 1, 1) && length(run) >= length(fence) && rest ~ /^[[:space:]]*$/) { fence = ""; next }
    }
    fence != "" { next }
    {
      line = $0
      gsub(/`[^`]*`/, "", line)
      reason = ""
      if (line ~ /^[[:space:]]*=== "/) reason = "MkDocs tab (use headings)"
      else if (line ~ /^[[:space:]]*!!! /) reason = "MkDocs admonition (use > [!NOTE])"
      else if (line ~ /^[[:space:]]*\?\?\?\+? /) reason = "MkDocs collapsible (use <details markdown=\"1\">)"
      else if (tolower(line) ~ /<(style|script)[[:space:]>]/) reason = "inline <style>/<script> (move to docs/assets)"
      else if (line ~ /\{:? ?([.#][A-Za-z]|[A-Za-z_][A-Za-z0-9_-]*=)[^}]*\}[[:space:]]*$/) reason = "attr_list { .class } / { key=value } (use HTML attributes)"
      else if (line ~ /--8<--/) reason = "snippet include"
      if (reason != "") printf "%s:%d: %s\n", FILENAME, FNR, reason
    }
  '
)"

if [[ -n "$violations" ]]; then
  echo "error: MkDocs-only syntax in docs/ breaks GitHub rendering:" >&2
  echo "$violations" >&2
  exit 1
fi

echo "docs/ Markdown is GitHub-compatible."
