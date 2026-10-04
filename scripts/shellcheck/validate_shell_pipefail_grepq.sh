#!/usr/bin/env bash
# Count-per-file ratchet for quiet grep pipeline consumers in scripts/**/*.sh
# containing a pipefail-enabling set command. Uses existing shfmt + jq tooling;
# the Bash AST excludes prose/comments/heredoc text while retaining substitutions.
# No control-flow analysis: enabling pipefail anywhere arms the whole file.
# Tiny writers still need an exception or a baseline entry.
# Suppress on the grep line or immediately preceding line with:
#   # pipefail-grep-q: allow <nonempty reason>
# For split pipelines the preceding line is commonly the writer ending in |.
# Missing reasons fail even without pipefail. Literal grep commands/options are
# checked; dynamically constructed commands/options and wrapper commands are not.
# Usage: bash scripts/shellcheck/validate_shell_pipefail_grepq.sh [--update [--allow-grow]]
# --update only shrinks per-file counts; --allow-grow explicitly seeds/grows them.
# SHELL_PIPEFAIL_GREPQ_ROOT and SHELL_PIPEFAIL_GREPQ_BASELINE isolate fixture runs.
set -euo pipefail
export LC_ALL=C
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/file-selection.sh disable=SC1091
source "$SCRIPT_DIR/../lib/file-selection.sh"
ROOT="${SHELL_PIPEFAIL_GREPQ_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BASELINE="${SHELL_PIPEFAIL_GREPQ_BASELINE:-$ROOT/scripts/shellcheck/pipefail-grepq-baseline.txt}"
MODE=check
ALLOW_GROW=false
for arg in "$@"; do
  case "$arg" in
    --update) MODE=update ;;
    --allow-grow) ALLOW_GROW=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done
if [[ "$ALLOW_GROW" == true && "$MODE" != update ]]; then
  echo '--allow-grow requires --update' >&2
  exit 2
fi
# The installer runs in a child process; expose its manual-install location here.
export PATH="$HOME/.local/bin:$PATH"
if [[ "${CI:-false}" == true ]]; then
  INSTALL_SHFMT_WHEN_MISSING="${INSTALL_SHFMT_WHEN_MISSING-true}"
else
  INSTALL_SHFMT_WHEN_MISSING="${INSTALL_SHFMT_WHEN_MISSING-false}"
fi
# Check jq first so a missing dependency does not trigger an unnecessary download.
if ! command -v jq > /dev/null 2>&1; then
  echo 'jq is required for shell AST scanning; install jq and ensure it is on PATH.' >&2
  exit 2
fi
if ! ensure_tool shfmt "$SCRIPT_DIR/install_shfmt.sh" "$INSTALL_SHFMT_WHEN_MISSING" >&2; then
  echo "shfmt is required for shell AST scanning; install it with bash '$SCRIPT_DIR/install_shfmt.sh' or set INSTALL_SHFMT_WHEN_MISSING=true and retry." >&2
  exit 2
fi
cd "$ROOT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# Materialize discovery so find/parser failures cannot be hidden in substitutions.
find scripts -type f -name '*.sh' -print > "$TMP/files"
: > "$TMP/sites"
while IFS= read -r file; do
  # Cheap prefilter only; AST decides whether this is executable pipefail/marker.
  if grep -E 'pipefail|pipefail-grep-q:' "$file" > /dev/null; then
    :
  else
    scan_status=$?
    if [[ $scan_status == 1 ]]; then continue; fi
    echo "Prefilter failed: $file" >&2
    exit 2
  fi
  if ! shfmt -ln bash -tojson < "$file" > "$TMP/ast"; then
    echo "Scanner failed: $file" >&2
    exit 2
  fi
  jq -r --arg file "$file" '
    def word:
      if .Type == "Lit" or .Type == "SglQuoted" then .Value
      elif .Type == "DblQuoted" or has("Parts") then
        [.Parts[]? | word] as $p | if all($p[]; . != null) then $p | join("") else null end
      else null end;
    def args: [.Args[]? | word];
    def quiet_options:
      if length == 0 or .[0] == "--" then false
      elif (.[0] // "" | test("^(-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)$")) then true
      elif (.[0] // "" | test("^(-[efmABC]|--regexp|--file|--max-count|--after-context|--before-context|--context)$")) then .[2:] | quiet_options
      else .[1:] | quiet_options end;
    def quiet:
      args as $a | $a[0] == "grep" and ($a[1:] | quiet_options);
    [.. | objects | select(has("Text") and has("Hash")) |
      select(.Text | test("^[ \\t]*pipefail-grep-q: allow"))] as $markers |
    [$markers[] | select(.Text | test("^[ \\t]*pipefail-grep-q: allow[ \\t]+[^ \\t]" ) | not) |
      "ERROR \($file):\(.Hash.Line): allow marker requires a reason"] as $errors |
    ([.. | objects | select(.Type? == "CallExpr") | args |
      select(.[0] == "set") | . as $a |
      any(range(1; length - 1); $a[.] != null and
        ($a[.] // "" | test("^-[A-Za-z]*o$")) and $a[. + 1] == "pipefail")] | any) as $enabled |
    $errors[],
    (if $enabled then
      .. | objects | select(.Type? == "BinaryCmd" and (.Op == "|" or .Op == "|&")) |
      .Y.Cmd | select(.Type? == "CallExpr" and quiet) | .Pos.Line as $line |
      select(any($markers[]; (.Hash.Line == $line or .Hash.Line == $line - 1)) | not) |
      "\($file):\($line): quiet grep pipeline under pipefail"
    else empty end)
  ' "$TMP/ast" >> "$TMP/sites"
done < "$TMP/files"
if grep '^ERROR ' "$TMP/sites"; then exit 1; fi
awk -F: '{count[$1]++} END {for (file in count) print count[file], file}' "$TMP/sites" | sort -k2 > "$TMP/current"
if [[ ! -f "$BASELINE" ]]; then
  if [[ "$MODE" != update || "$ALLOW_GROW" != true ]]; then
    echo "Missing baseline: $BASELINE (seed with --update --allow-grow)" >&2
    exit 1
  fi
  : > "$TMP/baseline"
else
  awk '!/^#/ && NF {if (NF != 2 || $1 !~ /^[0-9]+$/ || seen[$2]++) exit 2; print}' "$BASELINE" > "$TMP/baseline"
fi
# Separate file reads avoid the empty-first-file NR==FNR trap.
awk 'FILENAME == ARGV[1] {old[$2]=$1; next} $1 > old[$2] {print $2}' "$TMP/baseline" "$TMP/current" > "$TMP/grown"
if [[ -s "$TMP/grown" && ("$MODE" != update || "$ALLOW_GROW" != true) ]]; then
  echo 'New quiet grep pipeline finding(s); refusing baseline growth:' >&2
  while IFS= read -r file; do
    awk -v file="$file" 'index($0, file ":") == 1' "$TMP/sites" >&2
  done < "$TMP/grown"
  exit 1
fi
if [[ "$MODE" == update ]]; then
  {
    echo '# quiet grep pipeline baseline: count path (shrink-only per file).'
    echo '# Regenerate: bash scripts/shellcheck/validate_shell_pipefail_grepq.sh --update'
    cat "$TMP/current"
  } > "$BASELINE"
  echo "Wrote baseline: $BASELINE"
else
  if ! diff -q "$TMP/baseline" "$TMP/current" > /dev/null; then
    echo 'Note: findings removed; run --update to shrink the baseline.'
  fi
  echo 'No new quiet grep pipeline findings.'
fi
