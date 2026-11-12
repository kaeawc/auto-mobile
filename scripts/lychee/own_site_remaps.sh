#!/usr/bin/env bash
#
# own_site_remaps.sh
#
# Prints the lychee `--remap` rules that point the docs site's own absolute
# URLs (site_url and everything under it, e.g. https://kaeawc.github.io/auto-mobile/...)
# at a freshly built copy of the site, one rule per line. validate_lychee.sh
# passes each line to lychee as `--remap <rule>`, so a link to a page that only
# exists on the current commit (a new docs section) resolves against the build
# instead of the live site, which docs.yml republishes only nightly (#18185).
# A link to a page missing from the build still fails, as does a missing
# #fragment. Links to any other host are not touched.
#
# Two rules, first match wins:
#   1. Directory URLs (empty path or trailing `/`) map to that directory's
#      index.html, so #fragments are checked against the page MkDocs serves.
#   2. Every other URL maps to the file at the same path.
# A ?query is dropped (a static file ignores it); a #fragment is kept.
#
# Usage:
#   own_site_remaps.sh <site_url> <built_site_dir>
#
# Exit codes:
#   0 - rules printed
#   1 - usage error, or an argument lychee's whitespace-separated remap syntax
#       cannot carry (the caller then checks own-site links against the live site)
#
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <site_url> <built_site_dir>" >&2
    exit 1
fi

site_url="$1"
built_dir="$2"

if [[ ! "$site_url" =~ ^https?://[^/[:space:]]+(/[^[:space:]?#]*)?$ ]]; then
    echo "own_site_remaps.sh: unsupported site_url: '$site_url'" >&2
    exit 1
fi
if [[ "$built_dir" != /* || "$built_dir" =~ [[:space:]] ]]; then
    echo "own_site_remaps.sh: built site dir must be an absolute path without whitespace: '$built_dir'" >&2
    exit 1
fi

# Normalize to a trailing slash so the prefix only matches whole path segments
# (https://host/auto-mobile/ must not match https://host/auto-mobile-other/).
site_url="${site_url%/}/"
built_dir="${built_dir%/}"

# Escape regex metacharacters in the URL prefix, and `$` in the replacement
# (lychee uses Rust regex replacement syntax, where `$$` is a literal `$`).
prefix=$(printf '%s' "$site_url" | sed 's/[][\.*^$+?(){}|]/\\&/g')
target="file://${built_dir//\$/\$\$}/"

printf '%s\n' \
    "^${prefix}((?:[^?#]*/)?)(?:\\?[^#]*)?(#.*)?\$ ${target}\${1}index.html\${2}" \
    "^${prefix}([^?#]*)(?:\\?[^#]*)?(#.*)?\$ ${target}\${1}\${2}"
