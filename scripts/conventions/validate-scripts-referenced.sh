#!/usr/bin/env bash
set -euo pipefail

ROOT="${SCRIPTS_REFERENCED_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ALLOWLIST="scripts/conventions/unreferenced-scripts-allowlist.txt"
REPORT=false
if [[ "${1:-}" == "--report" ]]; then REPORT=true; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$ROOT"

git ls-files -- scripts | awk '/\.(sh|ts|py|mjs)$/ { print }' | sort -u > "$tmp/candidates"
# git grep -o emits path:token. Split at the first colon; repository paths cannot contain colons here.
git grep -I -o -E '[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.(sh|ts|py|mjs)' -- . ':!scratch/**' ":!$ALLOWLIST" 2>/dev/null \
  | awk 'index($0, ":") { file=substr($0,1,index($0,":")-1); token=substr($0,index($0,":")+1); print file "\t" token }' > "$tmp/refs" || :
# Match quoted import forms in source-like paths; awk below extracts the specifier and keeps its importer.
git grep -I -o -E '(from[[:space:]]+"[^" ]+"|import[[:space:]]*\("[^" ]+"[[:space:]]*\)|require\("[^" ]+"\)|^[[:space:]]*import[[:space:]]+"[^" ]+")' -- scripts test src .github package.json 2>/dev/null \
  | awk 'index($0, ":") { file=substr($0,1,index($0,":")-1); text=substr($0,index($0,":")+1); if (match(text, /"[^" ]+"/)) { spec=substr(text,RSTART+1,RLENGTH-2); print file "\t" spec } }' > "$tmp/imports" || :
if [[ ! -f "$ALLOWLIST" ]]; then : > "$tmp/allowlist"; else
  awk '/^[[:space:]]*#/ || /^[[:space:]]*$/ { next } { path=$1; reason=""; if (match($0, /#[[:space:]]*[^[:space:]].*/)) reason=substr($0,RSTART); print path "\t" reason }' "$ALLOWLIST" > "$tmp/allowlist"
fi

awk -F '\t' -v allowfile="$tmp/allowlist" -v unref="$tmp/unreferenced" -v testonly="$tmp/testonly" -v stale="$tmp/stale" -v listed="$tmp/listed" -v countfile="$tmp/count" -v failures="$tmp/failures" '
  FILENAME == ARGV[1] {
    candidate[++nc]=$0; n=split($0,a,"/"); b=a[n]; basecount[b]++; basepath[b,basecount[b]]=$0
    if (b ~ /\.(ts|mjs)$/) { sub(/\.(ts|mjs)$/,"",b); stemcount[b]++; stempre[b,stemcount[b]]=$0; stemcandidate[b,stemcount[b]]=$0 }
    # Python files in configured package roots are discovered by pytest/module import.
    if ($0 ~ /^scripts\/github\// || $0 ~ /^scripts\/manual-test\/python\//) discovery[$0]=1
    next
  }
  FILENAME == ARGV[2] {
    file=$1; token=$2; normalized=token; while (normalized ~ /^\.\.?\//) sub(/^\.\.?\//,"",normalized); sub(/^\//,"",normalized)
    n=split(normalized,a,"/"); b=a[n]; suffix=normalized
    # Shell variables may prefix a repository-relative suffix (for example $SCRIPT_DIR/lib/x.ts).
    if (n > 1 && (a[1] ~ /^\$/ || a[1] ~ /^[A-Z][A-Z0-9_]*$/ || a[1] ~ /_(root|dir)$/)) { suffix=""; for (j=2;j<=n;j++) suffix=suffix (j==2 ? "" : "/") a[j] }
    # Bare basename references intentionally satisfy all same-named candidates; qualified tokens require a path suffix match.
    for (i=1;i<=basecount[b];i++) { c=basepath[b,i]; if (file != c && (normalized !~ /\// || c == normalized || c == suffix || c ~ ("/" suffix "$"))) refs[c,file]=1 }
    next
  }
  FILENAME == ARGV[3] {
    file=$1; spec=$2; normalized=spec; while (normalized ~ /^\.\.?\//) sub(/^\.\.?\//,"",normalized); n=split(normalized,a,"/"); b=a[n]
    if (index(b,".")==0) for (i=1;i<=stemcount[b];i++) { c=stempre[b,i]; stempath=c; sub(/\.(ts|mjs)$/,"",stempath); if (file != c && (normalized !~ /\// || stempath == normalized || stempath ~ ("/" normalized "$"))) refs[c,file]=1 }
    next
  }
  FILENAME == allowfile { allowed[$1]=1; reason[$1]=$2; next }
  END {
    for (i=1;i<=nc;i++) { c=candidate[i]; count=0; non_test=0; for (key in refs) { split(key,k,SUBSEP); if (k[1]==c) { count++; f=k[2]; if (f !~ /^test\// && f !~ /\.bats$/ && f !~ /\.test\.ts$/) non_test=1 } }
      if (c in discovery) { count++; non_test=1 }
      if (!count) { state[c]="UNREFERENCED"; print "[scripts-referenced] UNREFERENCED " c > unref }
      else if (!non_test) { state[c]="TEST-ONLY"; print "[scripts-referenced] TEST-ONLY " c > testonly }
      else state[c]="REFERENCED"
    }
    for (p in allowed) { if (!(p in state) || state[p] != "UNREFERENCED" || reason[p] == "") { print "[scripts-referenced] STALE allow-list entry: " p " (missing, referenced, test-only, or empty reason)" > stale } }
    for (p in state) if (state[p]=="UNREFERENCED" && (p in allowed)) print "[scripts-referenced] ALLOW-LISTED " p " " reason[p] > listed
    print nc > countfile
    for (p in state) if (state[p]=="UNREFERENCED" && !(p in allowed)) print "[scripts-referenced] UNREFERENCED " p ": reference it from a workflow, package.json script, other script, scripts/README.md, or docs, or add an allow-list line with a reason." > failures
  }
' "$tmp/candidates" "$tmp/refs" "$tmp/imports" "$tmp/allowlist" > "$tmp/classification"

if $REPORT; then
  for file in "$tmp/unreferenced" "$tmp/testonly" "$tmp/listed"; do [[ -f "$file" ]] && sort "$file"; done
  exit 0
fi
if [[ -s "$tmp/stale" || -s "$tmp/failures" ]]; then
  [[ ! -s "$tmp/stale" ]] || sort "$tmp/stale" >&2
  [[ ! -s "$tmp/failures" ]] || sort "$tmp/failures" >&2
  exit 1
fi
count="$(cat "$tmp/count")"
printf '[scripts-referenced] All %s scripts are referenced.\n' "$count"
