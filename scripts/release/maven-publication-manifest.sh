#!/usr/bin/env bash
#
# Maven Central publication manifest + usage-budget preflight (issue #4853).
#
# Enumerates every file a tagged release would upload to Maven Central and prints
# a deterministic manifest: one line per file (coordinate, classifier, filename,
# bytes), per-coordinate subtotals, classifier totals, and a release grand total.
# It reads a locally-staged Maven file repository -- produced by
# `./gradlew publishAllPublicationsToCentralManifestRepository` (see the
# `centralManifest` repo in android/build.gradle.kts) -- so it needs NO Maven
# Central credentials and performs NO remote publish.
#
# Usage:
#   maven-publication-manifest.sh <staging-dir> [--budget <file>] [--strict]
#                                 [--group <groupId>]
#
# The manifest (stdout) is deterministic and path-independent so the artifact-
# reduction work (#4851, #4852) can diff a before/after capture as a regression
# oracle. Diagnostics go to stderr.
#
# Exit codes:
#   0  manifest generated. This is the default even when unexpected files are
#      present or the budget is exceeded -- the preflight reports, it never
#      blocks a release (a security fix must always ship).
#   1  --strict and an unexpected classifier/sidecar was found.
#   2  usage error (missing/for unreadable staging dir or budget file).
#   3  --strict and the usage budget was exceeded (no unexpected files).

set -euo pipefail

GROUP="dev.jasonpearson.auto-mobile"
budget_file=""
strict=0
staging=""

usage() {
  # Print the contiguous header comment block (line 2 to the first non-comment
  # line), stripping the leading "# ". Robust to line-number drift, so it never
  # leaks `set -euo pipefail` or the variable declarations into --help output.
  awk 'NR == 1 { next } /^#/ { sub(/^#+ ?/, ""); print; next } { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --budget)
      budget_file="${2:-}"
      [ -n "$budget_file" ] || { echo "error: --budget needs a file" >&2; exit 2; }
      shift 2
      ;;
    --group)
      GROUP="${2:-}"
      [ -n "$GROUP" ] || { echo "error: --group needs a value" >&2; exit 2; }
      shift 2
      ;;
    --strict) strict=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown option: $1" >&2; exit 2 ;;
    *)
      if [ -z "$staging" ]; then
        staging="$1"; shift
      else
        echo "error: unexpected argument: $1" >&2; exit 2
      fi
      ;;
  esac
done

[ -n "$staging" ] || { echo "error: no staging directory given" >&2; usage >&2; exit 2; }
[ -d "$staging" ] || { echo "error: staging directory not found: $staging" >&2; exit 2; }
# Strip every trailing slash (not just one) so ${path#"$staging"/} strips cleanly;
# keep "/" itself non-empty.
while [ "$staging" != "/" ] && [ "$staging" != "${staging%/}" ]; do
  staging="${staging%/}"
done

group_path="${GROUP//.//}"

# classify_versioned <filename> <artifact> <version>
# Files inside an artifact's version directory. Strips a trailing checksum
# extension and a .asc signature extension, then matches the base against the
# known primary set. Anything whose base is not a known primary is `unexpected`
# -- which catches both novel classifiers (a -tests.jar) and stray sidecars
# (a .asc.asc).
classify_versioned() {
  local name="$1" art="$2" ver="$3"
  local prefix="$art-$ver"
  local work="$name" checksum="" sig=""
  case "$work" in
    *.md5) checksum=1; work="${work%.md5}" ;;
    *.sha1) checksum=1; work="${work%.sha1}" ;;
    *.sha256) checksum=1; work="${work%.sha256}" ;;
    *.sha512) checksum=1; work="${work%.sha512}" ;;
  esac
  case "$work" in
    *.asc) sig=1; work="${work%.asc}" ;;
  esac
  local kind
  case "$work" in
    "$prefix.jar") kind=main-jar ;;
    "$prefix.aar") kind=main-aar ;;
    "$prefix-sources.jar") kind=sources-jar ;;
    "$prefix-javadoc.jar") kind=javadoc-jar ;;
    "$prefix.pom") kind=pom ;;
    "$prefix.module") kind=module ;;
    *) kind=unexpected ;;
  esac
  if [ "$kind" = unexpected ]; then echo unexpected; return; fi
  if [ -n "$sig" ] && [ -n "$checksum" ]; then echo signature-checksum; return; fi
  if [ -n "$sig" ]; then echo signature; return; fi
  if [ -n "$checksum" ]; then echo checksum; return; fi
  echo "$kind"
}

# classify_metadata <filename> -- maven-metadata.xml and its checksums, which sit
# one level above the version directory.
classify_metadata() {
  case "$1" in
    maven-metadata.xml) echo maven-metadata ;;
    maven-metadata.xml.md5|maven-metadata.xml.sha1|maven-metadata.xml.sha256|maven-metadata.xml.sha512)
      echo checksum ;;
    *) echo unexpected ;;
  esac
}

unexpected_count=0
total_files=0
total_bytes=0

records="$(mktemp)"
files_list="$(mktemp)"
trap 'rm -f "$records" "$files_list"' EXIT

# Enumerate the staged files first, and fail closed if traversal errors (e.g. an
# unreadable subtree) -- otherwise the error happens inside a process
# substitution where set -euo pipefail cannot see it, and the script would emit a
# partial manifest with exit 0. -H follows a command-line symlink to the repo dir
# so a symlinked staging path is traversed rather than counted as one file.
if ! find -H "$staging" -type f >"$files_list"; then
  echo "error: could not fully read staging directory: $staging" >&2
  exit 2
fi

# Known classifiers, printed in a fixed order for a stable classifier-totals line.
CLASSES="main-jar main-aar sources-jar javadoc-jar pom module maven-metadata signature checksum signature-checksum unexpected"

while IFS= read -r path; do
  name="${path##*/}"
  rel="${path#"$staging"/}"
  sub="${rel#"$group_path"/}"
  coord="unknown"
  classifier="unexpected"
  if [ "$sub" != "$rel" ]; then
    # sub is artifact/version/file (3 parts) or artifact/maven-metadata.xml (2).
    art="${sub%%/*}"
    tail="${sub#*/}"
    coord="$GROUP:$art"
    if [ "$tail" = "$sub" ]; then
      classifier="unexpected" # file directly under the group dir
    elif [ "${tail#*/}" = "$tail" ]; then
      classifier="$(classify_metadata "$tail")" # artifact/<file>
    else
      ver="${tail%%/*}"
      file="${tail#*/}"
      if [ "${file#*/}" != "$file" ]; then
        classifier="unexpected" # deeper than artifact/version/file
      else
        classifier="$(classify_versioned "$file" "$art" "$ver")"
      fi
    fi
  fi

  bytes="$(wc -c <"$path" | tr -d ' ')"
  # Tab-delimited so a stray unexpected filename containing spaces cannot shift
  # the bytes field in the awk aggregation below (Maven names never contain
  # spaces, but the tool must still count an unexpected file correctly).
  printf '%s\t%s\t%s\t%s\n' "$coord" "$classifier" "$name" "$bytes" >>"$records"

  total_files=$(( total_files + 1 ))
  total_bytes=$(( total_bytes + bytes ))
  if [ "$classifier" = unexpected ]; then
    unexpected_count=$(( unexpected_count + 1 ))
  fi
done < <(LC_ALL=C sort "$files_list")

echo >&2 "staging: $staging"

echo "# Maven Central publication manifest"
echo "# group: $GROUP"
echo "# columns: coordinate classifier filename bytes"
LC_ALL=C sort "$records" | tr '\t' ' '
echo
# Per-coordinate and per-classifier aggregation runs in awk, not bash associative
# arrays, so the script works on bash 3.2 (macOS system bash, used by CI's BATS).
# -F'\t' keeps a space-containing filename in a single field.
echo "## Per-coordinate totals"
# bytes is the LAST field ($NF), not $4, so even a filename containing tabs (which
# would add fields) cannot shift the byte count -- coord ($1) and classifier ($2)
# precede the name, so they are never shifted either.
awk -F'\t' '{ f[$1]++; b[$1] += $NF } END { for (c in f) printf "%s files=%d bytes=%d\n", c, f[c], b[c] }' \
  "$records" | LC_ALL=C sort
echo
echo "## Classifier totals"
awk -F'\t' -v classes="$CLASSES" '
  { c[$2]++ }
  END {
    n = split(classes, a, " ")
    out = ""
    for (i = 1; i <= n; i++) out = out (i > 1 ? " " : "") a[i] "=" (c[a[i]] + 0)
    print out
  }
' "$records"
echo
echo "## Release total"
coord_n="$(cut -f1 "$records" | LC_ALL=C sort -u | wc -l | tr -d ' ')"
echo "coordinates=$coord_n files=$total_files bytes=$total_bytes"

exit_code=0

if [ -n "$budget_file" ]; then
  [ -f "$budget_file" ] || { echo "error: budget file not found: $budget_file" >&2; exit 2; }
  command -v jq >/dev/null 2>&1 || { echo "error: jq is required for --budget" >&2; exit 2; }
  # Require EXACTLY ONE JSON object. Slurp (-s) so an empty file (0 values) or a
  # multi-document file (>1 value) fails closed instead of reading as "no limits"
  # -- jq -e without -s validates a stream one value at a time and would accept
  # both, and the later extraction would emit multiple lines.
  jq -e -s 'length == 1 and (.[0] | type == "object")' "$budget_file" >/dev/null 2>&1 || {
    echo "error: budget file must be a single JSON object: $budget_file" >&2
    exit 2
  }
  # Validate the whole budget shape and fail closed on anything malformed, so
  # nothing silently disables the budget -- not a `//` coalescing a false/null
  # field NOR a non-object `perRelease` (e.g. `false`) collapsing to `{}`. Rule:
  # perRelease is absent or an object; each threshold is absent or a non-negative
  # integer. Output is "maxFiles<TAB>maxBytes" (empty field = no limit), or the
  # sentinel INVALID.
  limits="$(jq -r -s '
    # Cap at 2^53, the largest EXACT integer for jq numbers (IEEE-754 doubles) and
    # safely inside a signed 64-bit range, so the emitted value is always plain
    # digits bash can compare. Realistic budgets are millions at most.
    def okint: type == "number" and . >= 0 and (floor == .) and . <= 9007199254740992;
    # floor normalizes to canonical decimal: jq 1.7+ preserves a literal like 1e6
    # and tostring would emit "1E+6", which the bash digit check would reject even
    # though it is a valid in-range integer. floor forces plain digits.
    def field($v): if $v == null then "" elif ($v | okint) then ($v | floor | tostring) else "INVALID" end;
    .[0].perRelease as $r
    | if $r == null then "\t"
      elif ($r | type) != "object" then "INVALID"
      else field($r.maxFiles) as $f | field($r.maxBytes) as $y
        | if ($f == "INVALID" or $y == "INVALID") then "INVALID" else ($f + "\t" + $y) end
      end
  ' "$budget_file")"
  if [ "$limits" = "INVALID" ]; then
    echo "error: budget perRelease must be an object with non-negative integer maxFiles/maxBytes" >&2
    exit 2
  fi
  max_files="$(printf '%s' "$limits" | cut -f1)"
  max_bytes="$(printf '%s' "$limits" | cut -f2)"
  breached=0
  # jq validates a non-negative integer but emits scientific notation for values
  # too large for bash (e.g. 1e100 -> "1E+100"), which bash's -gt cannot compare.
  # Require plain digits so an out-of-range threshold fails closed, not silently.
  for _v in "$max_files" "$max_bytes"; do
    if [ -n "$_v" ] && ! printf '%s' "$_v" | grep -qE '^[0-9]+$'; then
      echo "error: budget threshold out of range for comparison (got '$_v')" >&2
      exit 2
    fi
  done
  reasons=""
  if [ -n "$max_files" ] && [ "$total_files" -gt "$max_files" ]; then
    breached=1; reasons="files $total_files > $max_files"
  fi
  if [ -n "$max_bytes" ] && [ "$total_bytes" -gt "$max_bytes" ]; then
    breached=1
    [ -n "$reasons" ] && reasons="$reasons; "
    reasons="${reasons}bytes $total_bytes > $max_bytes"
  fi
  # Advisory per-javadoc-jar guard (#4852): the largest javadoc jar must stay
  # small so the empty jar cannot silently regress back to the full Dokka HTML
  # site. Validated the same way (absent or a non-negative integer).
  max_javadoc="$(jq -r -s '(.[0].perRelease.maxJavadocJarBytes) as $v
    | if $v == null then "" elif ($v | type == "number" and . >= 0 and (floor == .) and . <= 9007199254740992) then ($v | floor | tostring) else "INVALID" end' "$budget_file")"
  if [ "$max_javadoc" = "INVALID" ]; then
    echo "error: budget maxJavadocJarBytes must be a non-negative integer" >&2
    exit 2
  fi
  if [ -n "$max_javadoc" ] && ! printf '%s' "$max_javadoc" | grep -qE '^[0-9]+$'; then
    echo "error: budget maxJavadocJarBytes out of range for comparison (got '$max_javadoc')" >&2
    exit 2
  fi
  if [ -n "$max_javadoc" ]; then
    largest_javadoc="$(awk -F'\t' '$2 == "javadoc-jar" && $NF + 0 > m { m = $NF + 0 } END { print m + 0 }' "$records")"
    if [ "$largest_javadoc" -gt "$max_javadoc" ]; then
      breached=1
      [ -n "$reasons" ] && reasons="$reasons; "
      reasons="${reasons}javadoc-jar $largest_javadoc > $max_javadoc"
    fi
  fi
  echo
  if [ "$breached" -eq 1 ]; then
    echo "BUDGET WARN: $reasons (advisory -- does not block the release)"
    [ "$strict" -eq 1 ] && exit_code=3
  else
    echo "BUDGET OK: files=$total_files/${max_files:-inf} bytes=$total_bytes/${max_bytes:-inf}"
  fi
fi

if [ "$unexpected_count" -gt 0 ]; then
  echo >&2 "warning: $unexpected_count unexpected file(s) in the staged publication"
  [ "$strict" -eq 1 ] && exit_code=1
fi

exit "$exit_code"
