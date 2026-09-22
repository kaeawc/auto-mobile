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
    # Remove CommonMark inline code spans: a run of N backticks up to the next
    # run of exactly N backticks. An unmatched run stays as literal text.
    function strip_code_spans(s,    out, len, i, j, k, n, closed) {
      out = ""; len = length(s); i = 1
      while (i <= len) {
        if (substr(s, i, 1) != "`") { out = out substr(s, i, 1); i++; continue }
        n = 0; while (substr(s, i + n, 1) == "`") n++
        j = i + n; closed = 0
        while (j <= len) {
          if (substr(s, j, 1) != "`") { j++; continue }
          k = 0; while (substr(s, j + k, 1) == "`") k++
          if (k == n) { closed = 1; break }
          j += k
        }
        if (closed) { i = j + n } else { out = out substr(s, i, n); i += n }
      }
      return out
    }
    FNR == 1 { fence = ""; depth = 0 }
    # Fences follow CommonMark:
    # - a fence may be indented at most three spaces past the content column
    #   of the enclosing list item (0 at top level); deeper is an indented
    #   code line, not a fence;
    # - a backtick opener whose info string contains a backtick is not a fence;
    # - a fence closes only on the same character, at least as long as its
    #   opener, with nothing after it, so a shorter fence line inside a longer
    #   fence is content, not a close.
    match($0, /^ *(```+|~~~+)/) {
      indent = match($0, /[^ ]/) - 1
      run = substr($0, indent + 1)
      match(run, /^(`+|~+)/)
      rest = substr(run, RLENGTH + 1)
      run = substr(run, 1, RLENGTH)
      base = depth > 0 ? stack[depth] : 0
      if (fence == "") {
        if (indent - base <= 3 && !(run ~ /^`/ && rest ~ /`/)) { fence = run; next }
      } else if (substr(run, 1, 1) == substr(fence, 1, 1) && length(run) >= length(fence) && rest ~ /^[[:space:]]*$/) {
        fence = ""; next
      }
    }
    fence != "" { next }
    # Track list-item content columns so nested fences are measured relative
    # to their container. A non-blank line left of a content column closes
    # that list item.
    /[^[:space:]]/ {
      indent = match($0, /[^ ]/) - 1
      while (depth > 0 && indent < stack[depth]) depth--
      if (match($0, /^ *([-*+]|[0-9]+[.)]) +/)) stack[++depth] = RLENGTH
    }
    {
      line = strip_code_spans($0)
      reason = ""
      if (line ~ /^[[:space:]]*=== "/) reason = "MkDocs tab (use headings)"
      else if (line ~ /^[[:space:]]*!!! /) reason = "MkDocs admonition (use > [!NOTE])"
      else if (line ~ /^[[:space:]]*\?\?\?\+? /) reason = "MkDocs collapsible (use <details markdown=\"1\">)"
      else if (tolower(line) ~ /<(style|script)[[:space:]>]/) reason = "inline <style>/<script> (move to docs/assets)"
      else if (line ~ /\{:? ?([.#][A-Za-z]|[A-Za-z_][A-Za-z0-9_-]*=)[^}]*\}[[:space:]]*$/ || line ~ /[])*_]\{:? ?([.#][A-Za-z]|[A-Za-z_][A-Za-z0-9_-]*=)[^}]*\}/) reason = "attr_list { .class } / { key=value } (use HTML attributes)"
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
