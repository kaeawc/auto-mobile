#!/usr/bin/env bash
#
# One-way per-file size ratchet for src/ (#11784). A TypeScript file with more
# than FILE_SIZE_MAX (default 1000) non-blank lines is recorded at its current
# count in scripts/file-size-baseline.txt and may only shrink; a file that is
# not recorded may not exceed the cap. Counting non-blank lines (not oxlint's
# max-lines, which emits one diagnostic per file) keeps the stored value a real
# size, so a 10,000-line file cannot quietly regrow to 12,000.
#
# Usage:
#   scripts/file-size-baseline.sh                       # check mode
#   scripts/file-size-baseline.sh --update              # shrink the baseline
#   scripts/file-size-baseline.sh --update --allow-grow # record intentional growth

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Overrides for BATS fixtures; never touch the committed baseline in tests.
REPO="${FILE_SIZE_REPO:-$ROOT}"
BASELINE="${FILE_SIZE_BASELINE:-$ROOT/scripts/file-size-baseline.txt}"
MAX="${FILE_SIZE_MAX:-1000}"
cd "$REPO"

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

# "<non-blank lines>\t<file>" for every src file over the cap, sorted by file.
current="$(
  find src -type f -name '*.ts' -print0 \
    | xargs -0 awk -v max="$MAX" '
        NF { count[FILENAME]++ }
        END { for (file in count) if (count[file] > max) print count[file] "\t" file }
      ' \
    | sort -t "$(printf '\t')" -k2
)"
current_total="$(printf '%s\n' "$current" | awk -F '\t' 'NF == 2 {n++} END {print n+0}')"

# Compare each current file with its allowance: its recorded count, else the cap.
grown() {
  awk -F '\t' -v max="$MAX" '
    FNR == NR { if ($0 !~ /^#/ && NF == 2) allowed[$2] = $1; next }
    NF == 2 {
      limit = ($2 in allowed) ? allowed[$2] : max
      if ($1 > limit) print ($1 - limit) " over " (($2 in allowed) ? "baseline" : "cap") " in " $2
    }
  ' "$BASELINE" <(printf '%s\n' "$current")
}

if [[ "$MODE" == "update" ]]; then
  if [[ -f "$BASELINE" && "$ALLOW_GROW" != "true" ]]; then
    grew="$(grown)"
    if [[ -n "$grew" ]]; then
      echo "refusing to grow the baseline: a file grew or a new file is over the cap:" >&2
      printf '%s\n' "$grew" >&2
      echo "The file-size ratchet is one-way. If this growth is intended," >&2
      echo "re-run with: bun run lint:file-size:baseline -- --allow-grow" >&2
      exit 1
    fi
  fi
  {
    echo "# AutoMobile file-size ratchet baseline (non-blank lines, cap $MAX) -- see scripts/file-size-baseline.sh"
    [[ -n "$current" ]] && printf '%s\n' "$current"
  } > "$BASELINE"
  echo "Updated $BASELINE ($current_total file(s) over $MAX lines)."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "ERROR: baseline missing: $BASELINE" >&2
  echo "Generate it once with: bun run lint:file-size:baseline" >&2
  exit 1
fi

grew="$(grown)"
if [[ -n "$grew" ]]; then
  echo "file-size ratchet: src files grew past their baseline or a new file is over $MAX lines." >&2
  echo "Extract code instead, or (rarely) record it with --update --allow-grow:" >&2
  printf '%s\n' "$grew" >&2
  exit 1
fi
echo "file-size ratchet gate: no growth ($current_total file(s) over $MAX lines in baseline)."
