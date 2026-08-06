#!/usr/bin/env bash
#
# Scoped oxlint ratchet gate (TypeScript-7 / oxlint migration).
#
# oxlint has no equivalent of ESLint's native bulk-suppressions file
# (eslint-suppressions.json): it offers only inline `oxlint-disable` directives
# and whole-rule `--allow`. So the count-based ratchet that let CI gate NEW
# violations of rules added after the code was written has to be rebuilt as an
# external gate -- exactly like scripts/typecheck-baseline.sh does for `tsc`.
#
# The rules gated here are the ones .oxlintrc.json sets to "warn" because they
# carry pre-existing violations (complexity, max-depth,
# auto-mobile/catch-convention, auto-mobile/no-unknown-cast, and the two
# type-aware promise rules). Every OTHER rule is "error" in the config and is
# gated directly by `oxlint` (a non-zero exit), so it does not belong here. The
# promise rules need type information, so this gate runs oxlint with
# `--type-aware` (tsgolint) -- which is why the main `oxlint --fix` does not, and
# CI type-checks only once. As these are burned down the baseline shrinks; it is
# a one-way ratchet:
#   * A NEW violation (a higher per-file count, or a new file+rule pair) fails the
#     gate. The only way to record one is `--update`, which REFUSES to write a
#     larger baseline unless `--allow-grow` is passed.
#   * When you FIX violations the gate stays green and reminds you to `--update`
#     so the baseline shrinks. It is expected to trend toward zero.
#
# The baseline is keyed per (file, rule) with only a COUNT -- the same granularity
# as eslint-suppressions.json -- so it does not churn on unrelated line shifts.
#
# Usage:
#   scripts/oxlint-baseline.sh                      # check mode (CI gate)
#   scripts/oxlint-baseline.sh --update             # regenerate (refuses to grow)
#   scripts/oxlint-baseline.sh --update --allow-grow  # regenerate, allow growth

set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# OXLINT_BASELINE overrides the baseline location (used by the BATS tests so they
# never touch the committed baseline).
BASELINE="${OXLINT_BASELINE:-$ROOT/scripts/oxlint-baseline.txt}"
cd "$ROOT"

MODE="check"
ALLOW_GROW="false"
for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    --allow-grow) ALLOW_GROW="true" ;;
    *)
      echo "Unknown argument: $arg (expected --update and/or --allow-grow)" >&2
      exit 2
      ;;
  esac
done
if [[ "$ALLOW_GROW" == "true" && "$MODE" != "update" ]]; then
  echo "--allow-grow is only valid with --update" >&2
  exit 2
fi

# The oxlint rule codes gated by this ratchet. Kept in lock-step with the "warn"
# rules in .oxlintrc.json.
RATCHET_CODES="eslint(complexity) eslint(max-depth) auto-mobile(catch-convention) auto-mobile(no-unknown-cast) typescript(no-floating-promises) typescript(no-misused-promises)"

# Emit the JSON report. OXLINT_JSON_CMD overrides the invocation -- used by the
# BATS tests to inject a canned report. It is `eval`ed, so treat it as TRUSTED
# input only (never wire it from an untrusted source).
run_oxlint_json() {
  if [[ -n "${OXLINT_JSON_CMD:-}" ]]; then
    eval "$OXLINT_JSON_CMD"
  else
    bunx oxlint --type-aware --format json 2>/dev/null
  fi
}

# Reduce the JSON report to sorted "<count>\t<filename>\t<code>" lines, counting
# only the ratcheted codes. JSON is parsed with a real parser (bun -- the repo's
# only guaranteed runtime; Node is optional here), never line regexes, since
# diagnostic messages contain arbitrary text.
extract_counts() {
  bun -e '
    const codes = new Set(process.argv[1].split(" "));
    let raw = "";
    process.stdin.on("data", c => raw += c).on("end", () => {
      let report;
      try { report = JSON.parse(raw); }
      catch { process.stderr.write("oxlint did not emit parseable JSON\n"); process.exit(3); }
      const counts = new Map();
      for (const d of (report.diagnostics || [])) {
        if (!codes.has(d.code)) { continue; }
        const key = d.filename + "\t" + d.code;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const lines = [...counts.entries()].map(([k, n]) => n + "\t" + k).sort();
      process.stdout.write(lines.length ? lines.join("\n") + "\n" : "");
    });
  ' "$RATCHET_CODES"
}

# Compare current counts against a baseline PER (file, rule). Emits one
# "<delta> new in <file>  <code>" line for every key whose current count exceeds
# the baseline (or that the baseline lacks). Both inputs are the
# "<count>\t<file>\t<code>" text produced by extract_counts. This is the single
# source of truth for "did anything get worse" -- used by BOTH the update
# grow-guard and the check gate, so a count-neutral SWAP (fix one key, add a
# different one) is rejected, not just an increase in the aggregate total.
new_or_increased() {
  bun -e '
    const parse = s => {
      const m = new Map();
      for (const line of s.split("\n")) {
        if (!line.trim()) { continue; }
        const [count, file, code] = line.split("\t");
        m.set(file + "\t" + code, Number(count));
      }
      return m;
    };
    const base = parse(process.argv[1]);
    const cur = parse(process.argv[2]);
    const news = [];
    for (const [key, n] of cur) {
      const allowed = base.get(key) || 0;
      if (n > allowed) { news.push((n - allowed) + " new in " + key.replace("\t", "  ")); }
    }
    process.stdout.write(news.join("\n"));
  ' "$1" "$2"
}

report_json="$(run_oxlint_json)"
current="$(printf '%s' "$report_json" | extract_counts)"
current_total="$(printf '%s' "$current" | awk -F'\t' 'NF{s+=$1} END{print s+0}')"

if [[ "$MODE" == "update" ]]; then
  if [[ -f "$BASELINE" && "$ALLOW_GROW" != "true" ]]; then
    # Refuse to grow ANY (file, rule) key, not just the aggregate total -- else a
    # count-neutral swap (fix one key, add a different one) would rewrite the
    # baseline and the subsequent check would then accept the new defect.
    prev_counts="$(grep -vE '^#|^$' "$BASELINE" || true)"
    grew="$(new_or_increased "$prev_counts" "$current")"
    if [[ -n "$grew" ]]; then
      echo "refusing to grow the baseline: a (file, rule) count increased or a new pair appeared:" >&2
      printf '%s\n' "$grew" >&2
      echo "The oxlint ratchet is a one-way ratchet. If this growth is truly" >&2
      echo "intended, re-run with:  bun run lint:prune -- --allow-grow" >&2
      exit 1
    fi
  fi
  {
    echo "# AutoMobile oxlint ratchet baseline -- see scripts/oxlint-baseline.sh"
    echo "# Gated rules: $RATCHET_CODES"
    printf '%s\n' "$current"
  } > "$BASELINE"
  echo "Updated $BASELINE ($current_total gated violation(s))."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "ERROR: baseline missing: $BASELINE" >&2
  echo "Generate it once with: bun run lint:prune" >&2
  exit 1
fi

# Compare per (file, rule): fail on any count that increased or any new pair.
# The baseline is authoritative for what is tolerated; a lower current count is
# fine (and should be pruned with --update).
baseline_counts="$(grep -vE '^#|^$' "$BASELINE" || true)"
new_violations="$(new_or_increased "$baseline_counts" "$current")"

if [[ -n "$new_violations" ]]; then
  echo "oxlint ratchet: NEW violation(s) of a gated rule -- fix them or (rarely) record with --update:" >&2
  printf '%s\n' "$new_violations" >&2
  exit 1
fi

echo "oxlint ratchet gate: no new violations ($current_total gated violation(s) in baseline)."
exit 0
