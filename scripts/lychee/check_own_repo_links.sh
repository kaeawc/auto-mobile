#!/usr/bin/env bash
#
# check_own_repo_links.sh
#
# Verifies, offline, every documentation link to a path in THIS repository at
# `blob/main` or `tree/main` against the checked-out tree. github.com answers
# these with intermittent 504s under bulk lookups, and the answer is knowable
# without the network anyway. `.lycherc.toml` excludes the same URL shape from
# lychee's network pass; this script is its replacement.
#
# A `blob` link must name an existing file, a `tree` link an existing directory.
# A `#L<n>` or `#L<n>-L<m>` anchor on a `blob` link must lie within the file.
#
# Usage: check_own_repo_links.sh [file ...]
#   With no files: docs/ (*.md, *.html), root *.md, .github/CONTRIBUTING.md.
# Env: OWN_REPO_ROOT overrides the tree to resolve against (default: repo root).
#
# Exit codes: 0 all links resolve, 2 at least one dead link.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${OWN_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PREFIX='https://github.com/kaeawc/auto-mobile/'
URL_PATTERN="https://github\.com/kaeawc/auto-mobile/(blob|tree)/main[^][:space:])\"'<>\`]*"

files=("$@")
if [[ ${#files[@]} -eq 0 ]]; then
    cd "$ROOT"
    while IFS= read -r f; do files+=("$f"); done < <(
        {
            find docs -type f \( -name '*.md' -o -name '*.html' \) 2>/dev/null
            find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||'
            if [[ -f .github/CONTRIBUTING.md ]]; then echo .github/CONTRIBUTING.md; fi
        } | sort -u
    )
fi

# Echoes the reason a link is dead, or nothing when it resolves.
dead_reason() {
    local url="$1" rest kind anchor="" rel target last total
    rest="${url#"$PREFIX"}"
    kind="${rest%%/*}"
    rest="${rest#*/main}"
    rest="${rest#/}"
    if [[ "$rest" == *'#'* ]]; then
        anchor="${rest#*#}"
        rest="${rest%%#*}"
    fi
    rest="${rest%%\?*}"
    rest="${rest%/}"
    # Percent-decode (%20 etc.) so a link with encoded characters resolves.
    rel="$(printf '%b' "${rest//%/\\x}")"
    target="$ROOT/$rel"
    if [[ "$kind" == "tree" ]]; then
        [[ -d "$target" ]] || echo "directory not found"
        return 0
    fi
    if [[ -z "$rel" || ! -f "$target" ]]; then
        echo "file not found"
        return 0
    fi
    if [[ "$anchor" =~ ^L([0-9]+)(-L([0-9]+))?$ ]]; then
        last="${BASH_REMATCH[3]:-${BASH_REMATCH[1]}}"
        total="$(wc -l <"$target" | tr -d ' ')"
        # A final line without a trailing newline is not counted by wc -l.
        if [[ -n "$(tail -c1 "$target")" ]]; then total=$((total + 1)); fi
        if [[ "${BASH_REMATCH[1]}" -lt 1 || "$last" -gt "$total" ]]; then
            echo "line anchor #$anchor is past EOF ($total lines)"
        fi
    fi
}

checked=0
dead=0
for file in "${files[@]}"; do
    [[ -f "$file" ]] || continue
    # grep -n -o yields "<line>:<url>"; the URL's own colon stays in the last field.
    while IFS=: read -r lineno url; do
        [[ -n "$url" ]] || continue
        checked=$((checked + 1))
        reason="$(dead_reason "$url")"
        if [[ -n "$reason" ]]; then
            echo "[DEAD] $file:$lineno: $url ($reason)"
            dead=$((dead + 1))
        fi
    done < <(grep -noE "$URL_PATTERN" "$file" | sed -E 's/[.,;:]+$//' || true)
done

echo "own-repo links checked offline: $checked, dead: $dead"
if [[ "$dead" -ne 0 ]]; then exit 2; fi
