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
# carry pre-existing violations (historically complexity, max-depth, max-params,
# max-lines-per-function, auto-mobile/catch-convention, ...), plus the two
# type-aware promise rules. Those are "error" in the config with a zero baseline,
# but they only run under `--type-aware`, which the fast `oxlint` stage does not
# use, so this gate is what enforces them (any diagnostic is a new violation).
# Every OTHER rule is "error" in the config and is gated directly by `oxlint` (a
# non-zero exit), so it does not belong here. The
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
# Inline suppressions are ratcheted too. An `oxlint-disable*` / `eslint-disable*`
# directive removes the diagnostic from oxlint's report, so without this a new
# violation could be hidden instead of failing. scripts/lib/oxlintDisableScan.ts
# scans the comments of every file oxlint lints (repo-wide via git ls-files, minus
# the .oxlintrc.json ignorePatterns; it fails closed when none are found) with the
# TypeScript scanner, and this script merges its rows into the same baseline and
# the same new_or_increased compare:
#   <count>  <file>  oxlint-disable(<rule>)            every -next-line directive, per rule
#   <count>  <file>  oxlint-disable-line(<rule>)       every -line directive, per rule
#   <count>  <file>  oxlint-disable-block(<rule>)      every unbounded directive a later enable closes
#   <count>  <file>  oxlint-disable-partial(*)         a bare unbounded disable only named enables partly re-enable
#   <count>  <file>  oxlint-disable-file(<rule>)       every unbounded directive left open to end of file
#   <count>  <file>  oxlint-disable-no-reason(<rule>)  those lacking a `-- reason`
# A new suppression therefore fails like a new violation and needs --allow-grow,
# and removing one shrinks the baseline via --update. Narrowing a baselined
# unbounded directive (-file to -partial to -block, e.g. adding the enable that
# closes it) moves its count to a narrower row of the same file+rule; the
# compare treats that as a shrink (no --allow-grow), while the reverse (dropping
# a closer) is still growth. A directive listing several
# rules counts once per rule; `eslint/<rule>` is normalised to `<rule>`. The
# no-reason row has no tolerance beyond the baseline: pre-existing reason-less
# directives are recorded, but a NEW one grows that row and fails even if an
# equal number of reasoned ones were removed. Write
# `// oxlint-disable-next-line <rule> -- <why>`.
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

# shellcheck source=scripts/lib/host-heavy-run.sh
source "$ROOT/scripts/lib/host-heavy-run.sh"

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

# The oxlint rule codes gated by this ratchet (including max-params and
# max-lines-per-function). Kept in lock-step with the burned-down
# rules in .oxlintrc.json. The two typescript(no-*-promises) codes are "error" with
# a zero baseline; they stay here because only this stage runs `--type-aware`,
# so removing them would leave them unenforced.
RATCHET_CODES="typescript(no-floating-promises) typescript(no-misused-promises)"

# Emit the JSON report. OXLINT_JSON_CMD overrides the invocation -- used by the
# BATS tests to inject a canned report. It is `eval`ed, so treat it as TRUSTED
# input only (never wire it from an untrusted source).
run_oxlint_json() {
  # oxlint exits non-zero whenever it reports an error-level diagnostic (including
  # a parse error). That must not abort here under `set -e` with no message:
  # extract_counts names the failing file, or reports unparseable output.
  if [[ -n "${OXLINT_JSON_CMD:-}" ]]; then
    eval "$OXLINT_JSON_CMD" || true
  else
    # The exit status is deliberately ignored (see above). `set +e` instead of `|| true` keeps
    # errexit from being disabled inside host_heavy_run.
    set +e
    host_heavy_run host_heavy_oxlint_type_aware
    set -e
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
      // A file oxlint could not parse yields an error diagnostic with no rule code.
      const parseErrors = (report.diagnostics || []).filter(d => !d.code);
      if (parseErrors.length) {
        for (const d of parseErrors) {
          const at = d.labels && d.labels[0] && d.labels[0].span;
          const loc = at ? ":" + at.line + ":" + at.column : "";
          process.stderr.write("oxlint parse error in " + String(d.filename).replace(/\\/g, "/") + loc + ": " + d.message + "\n");
        }
        process.exit(3);
      }
      for (const d of (report.diagnostics || [])) {
        if (!codes.has(d.code)) { continue; }
        // Normalize path separators so the committed baseline (forward slashes)
        // matches regardless of the OS oxlint ran on (Windows emits backslashes).
        const file = String(d.filename).replace(/\\/g, "/");
        const key = file + "\t" + d.code;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const lines = [...counts.entries()].map(([k, n]) => n + "\t" + k).sort();
      process.stdout.write(lines.length ? lines.join("\n") + "\n" : "");
    });
  ' "$RATCHET_CODES"
}

# Compare current counts against a baseline PER (file, rule). Emits one
# "<delta> new in <file>  <code>" line for every key whose current count exceeds
# the baseline (or that the baseline lacks). This is the single source of truth
# for "did anything get worse" -- used by BOTH the update grow-guard and the
# check gate, so a count-neutral SWAP (fix one key, add a different one) is
# rejected, not just an increase in the aggregate total.
#
# Both blobs arrive on STDIN, baseline first, separated by a sentinel line, NOT
# as argv: the combined text is tens of KB and passing it as command-line
# arguments overflows the OS argument-length limit on Windows ("Argument list too
# long"). Blank and "#"-comment lines are ignored, so a raw baseline file works.
new_or_increased() {
  bun -e '
    let raw = "";
    process.stdin.on("data", c => raw += c).on("end", () => {
      const [baseText, curText = ""] = raw.split("\n@@@OXLINT_SEP@@@\n");
      const parse = s => {
        const m = new Map();
        for (const line of s.split("\n")) {
          if (!line.trim() || line[0] === "#") { continue; }
          const [count, file, code] = line.split("\t");
          m.set(file + "\t" + code, Number(count));
        }
        return m;
      };
      const base = parse(baseText);
      const cur = parse(curText);
      const news = [];
      // Unbounded disables narrow in one direction: -file (open to EOF), then
      // -partial (a bare disable some named enables re-enable), then -block
      // (closed). A count that leaves a wider row may land on a narrower row of
      // the same file+rule without counting as growth; the reverse (dropping a
      // closer) is a new row. Each freed count is spent once, widest first.
      const SCOPES = ["file", "partial", "block"];
      const scopeOf = (key) => /\toxlint-disable-(file|partial|block)\((.*)\)$/.exec(key);
      const grouped = new Set();
      for (const [key, n] of cur) {
        const m = scopeOf(key);
        if (m) {
          grouped.add(key.slice(0, m.index) + "\t" + m[2]);
          continue;
        }
        const allowed = base.get(key) || 0;
        if (n > allowed) { news.push((n - allowed) + " new in " + key.replace("\t", "  ")); }
      }
      for (const group of grouped) {
        const tab = group.lastIndexOf("\t");
        const file = group.slice(0, tab);
        const rule = group.slice(tab + 1);
        let freed = 0;
        for (const scope of SCOPES) {
          const key = file + "\toxlint-disable-" + scope + "(" + rule + ")";
          const allowed = (base.get(key) || 0) + freed;
          const n = cur.get(key) || 0;
          if (n > allowed) { news.push((n - allowed) + " new in " + key.replace("\t", "  ")); }
          freed = Math.max(0, allowed - n);
        }
      }
      process.stdout.write(news.join("\n"));
    });
  '
}

# Feed two count blobs to new_or_increased over stdin with the sentinel between.
compare_counts() {
  printf '%s\n@@@OXLINT_SEP@@@\n%s' "$1" "$2" | new_or_increased
}

# Suppression rows. OXLINT_SCAN_ROOT overrides the scanned root (BATS fixtures).
scan_suppressions() {
  bun "$ROOT/scripts/lib/oxlintDisableScan.ts" "${OXLINT_SCAN_ROOT:-$ROOT}"
}

report_json="$(run_oxlint_json)"
violations="$(printf '%s' "$report_json" | extract_counts)"
suppressions="$(scan_suppressions)"
current="$(printf '%s\n%s\n' "$violations" "$suppressions" | grep -v '^$' | sort || true)"
violation_total="$(printf '%s' "$violations" | awk -F'\t' 'NF{s+=$1} END{print s+0}')"
# Directives only; the no-reason rows are a subset and would double count.
suppression_total="$(printf '%s' "$suppressions" | awk -F'\t' 'NF && $3 !~ /^oxlint-disable-no-reason/ {s+=$1} END{print s+0}')"
summary="$violation_total gated violation(s), $suppression_total suppression row(s)"

if [[ "$MODE" == "update" ]]; then
  if [[ -f "$BASELINE" && "$ALLOW_GROW" != "true" ]]; then
    # Refuse to grow ANY (file, rule) key, not just the aggregate total -- else a
    # count-neutral swap (fix one key, add a different one) would rewrite the
    # baseline and the subsequent check would then accept the new defect.
    prev_counts="$(grep -vE '^#|^$' "$BASELINE" || true)"
    grew="$(compare_counts "$prev_counts" "$current")"
    if [[ -n "$grew" ]]; then
      echo "refusing to grow the baseline: a (file, rule) count (violation or oxlint-disable suppression) increased or a new pair appeared:" >&2
      printf '%s\n' "$grew" >&2
      echo "The oxlint ratchet is a one-way ratchet. If this growth is truly" >&2
      echo "intended, re-run with:  bun run lint:prune -- --allow-grow" >&2
      exit 1
    fi
  fi
  {
    echo "# AutoMobile oxlint ratchet baseline -- see scripts/oxlint-baseline.sh"
    echo "# Gated rules: $RATCHET_CODES"
    echo "# Also counted: oxlint-disable(<rule>) and oxlint-disable-no-reason(<rule>) rows from the comment scan"
    printf '%s\n' "$current"
  } > "$BASELINE"
  echo "Updated $BASELINE ($summary)."
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
new_violations="$(compare_counts "$baseline_counts" "$current")"

if [[ -n "$new_violations" ]]; then
  echo "oxlint ratchet: NEW violation(s) or oxlint-disable suppression(s) -- fix them or (rarely) record with --update --allow-grow:" >&2
  printf '%s\n' "$new_violations" >&2
  exit 1
fi

echo "oxlint ratchet gate: no new violations ($summary in baseline)."
exit 0
