#!/usr/bin/env bash
#
# Published-consumer regression for the debug storage-inspection providers
# (issue #5714).
#
# The database / shared-preference inspection ContentProviders and their
# `<provider>` manifest entries live in `auto-mobile-sdk/src/debug` only. The SDK
# used to publish a single (release) variant, so a consumer resolving the module
# from Maven -- rather than as an in-repo `project()` dependency whose debug
# variant is picked up automatically -- received an AAR with no inspection
# providers at all, and could not make the endpoints available even in a debug
# build. Publishing both variants (AndroidMultiVariantLibrary) fixes that.
#
# This guard exercises the *published* dependency path, not the in-repo module
# path: it publishes the SDK to the local Maven repository and asserts against
# the resolved artifacts and their Gradle Module Metadata that
#
#   AC1  the published debug AAR declares both exported inspection providers,
#   AC2  the published debug AAR carries both provider classes (so inspection
#        can actually run against a debug consumer),
#   AC3  the published release AAR declares and packages neither provider, and
#   AC4  the module metadata routes a debug consumer to the provider-bearing
#        debug AAR and a release consumer to the provider-free release AAR.
#
# Usage:
#   validate-sdk-debug-inspector-consumer.sh [--skip-publish] [--repo <dir>]
#
#   --skip-publish  Assert against an already-published local repo (CI publishes
#                   with the cached gradle-task-run action in a prior step).
#   --repo <dir>    Local Maven repository root (default: ~/.m2/repository).
#
# Exit codes: 0 all assertions pass; 1 a published-artifact assertion failed;
#             2 usage / environment error.
set -euo pipefail

# --- pure, sourceable assertion helpers (unit-tested by BATS) ---------------

# Extract one file entry from an AAR (a zip) to stdout.
aar_entry() {
  local aar="$1" entry="$2"
  unzip -p "$aar" "$entry"
}

# Count `<provider>` elements in an Android manifest whose android:name matches a
# fully-qualified class name. With a third argument "exported", only providers
# with android:exported="true" are counted. Echoes an integer.
#
# Parsed with python3's ElementTree (a real, namespace-aware structured parser)
# rather than xmllint: libxml2-utils is not installed on the GitHub ubuntu
# runners, while python3 is guaranteed there and on macOS -- and it beats
# regex-matching XML by hand.
manifest_provider_match_count() {
  local manifest="$1" fqcn="$2" exported_only="${3:-}"
  python3 - "$manifest" "$fqcn" "$exported_only" <<'PY'
import sys, xml.etree.ElementTree as ET
A = "{http://schemas.android.com/apk/res/android}"
manifest, fqcn, exported_only = sys.argv[1], sys.argv[2], sys.argv[3]
root = ET.parse(manifest).getroot()
n = 0
for p in root.iter("provider"):
    if p.get(A + "name") != fqcn:
        continue
    if exported_only == "exported" and p.get(A + "exported") != "true":
        continue
    n += 1
print(n)
PY
}

# Count exported `<provider>` elements matching a fully-qualified class name.
manifest_provider_count() {
  manifest_provider_match_count "$1" "$2" exported
}

# Count `<provider>` elements matching a fully-qualified class name regardless of
# their exported value. Used to assert an inspection provider is wholly absent
# from the release manifest (scoped to the two inspection providers by name, so
# an unrelated release-safe provider added later under src/main does not trip it).
manifest_named_provider_count() {
  manifest_provider_match_count "$1" "$2"
}

# Echo 1 if the AAR's classes.jar contains the given class path, else 0. Matches
# the zip entry name exactly (`unzip -Z1` lists names, one per line) so a partial
# or whitespace-adjacent path cannot produce a false positive. Echoes a value
# (rather than returning a status) so callers capture it by assignment and stay
# clear of the set -e-suppressed condition forms the SC2310 ratchet guards.
#
# The entry list is captured first and matched with a here-string, never
# `unzip -Z1 | grep -q`: under `set -o pipefail` an early-exiting `grep -q` sends
# SIGPIPE up to unzip, and the 141 exit then makes the pipeline spuriously fail
# -- a nondeterministic false negative.
aar_class_present() {
  local aar="$1" class_path="$2" tmp entries
  tmp="$(mktemp)"
  aar_entry "$aar" classes.jar >"$tmp"
  entries="$(unzip -Z1 "$tmp")"
  rm -f "$tmp"
  if grep -qxF "$class_path" <<<"$entries"; then echo 1; else echo 0; fi
}

# Echo the AAR filename the module metadata routes a consumer of the given build
# type to (the java-runtime library variant). Empty if there is no such variant.
#
# The variant must also be selectable by a plain dependency on the coordinate:
# a variant that declares a non-default capability cannot be resolved via
# `implementation("group:name:version")` (Gradle fails with "Unable to find a
# variant with the requested capabilities"), so a build-type match alone would
# overstate AC4. Accept the variant only when its capabilities are absent/empty
# (the default capability) or every one equals the module's own group:name.
#
# `first(...)` emits at most one line inside jq rather than piping to `head`,
# which under `set -o pipefail` could SIGPIPE jq and fail the substitution.
module_runtime_aar_for_build_type() {
  local module="$1" build_type="$2"
  jq -r --arg bt "$build_type" '
    .component as $c
    | [ .variants[]
        | select(
            .attributes["com.android.build.api.attributes.BuildTypeAttr"] == $bt
            and .attributes["org.gradle.usage"] == "java-runtime"
            and .attributes["org.gradle.category"] == "library")
        | select((.capabilities // []) | all(.group == $c.group and .name == $c.module))
        | .files[0].name
      ] as $m
    # Exactly one selectable variant must match: two indistinguishable variants
    # make the coordinate ambiguous and Gradle refuses to resolve it, so "first
    # match wins" would overstate AC4.
    | if ($m | length) == 1 then $m[0] else "" end' "$module"
}

# --- orchestration ----------------------------------------------------------

DB_PROVIDER="dev.jasonpearson.automobile.sdk.database.DatabaseInspectorProvider"
SP_PROVIDER="dev.jasonpearson.automobile.sdk.storage.SharedPreferencesInspectorProvider"
DB_PROVIDER_CLASS="dev/jasonpearson/automobile/sdk/database/DatabaseInspectorProvider.class"
SP_PROVIDER_CLASS="dev/jasonpearson/automobile/sdk/storage/SharedPreferencesInspectorProvider.class"

fail() {
  echo "error: $*" >&2
  exit 1
}

run_validation() {
  local skip_publish=0 repo="${HOME}/.m2/repository"
  while [ $# -gt 0 ]; do
    case "$1" in
      --skip-publish) skip_publish=1; shift ;;
      --repo) repo="${2:-}"; [ -n "$repo" ] || { echo "error: --repo needs a dir" >&2; exit 2; }; shift 2 ;;
      -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "error: unknown argument: $1" >&2; exit 2 ;;
    esac
  done

  for tool in unzip python3 jq; do
    command -v "$tool" >/dev/null 2>&1 || { echo "error: required tool not found: $tool" >&2; exit 2; }
  done

  # Anchor a relative --repo to the caller's cwd BEFORE it reaches either side.
  # The assertions read "${repo}/..." relative to the caller, but Gradle resolves
  # a relative `-Dmaven.repo.local` against its own working directory -- so a
  # relative repo would publish to one place and be checked in another.
  case "$repo" in
    /*) : ;;
    *) repo="$(pwd)/$repo" ;;
  esac

  local script_dir project_root android_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  project_root="$(cd -- "${script_dir}/../.." && pwd)"
  android_dir="${project_root}/android"

  local group version
  group="$(sed -n 's/^GROUP=//p' "${android_dir}/gradle.properties" | head -n 1)"
  version="$(sed -n 's/^VERSION_NAME=//p' "${android_dir}/gradle.properties" | head -n 1)"
  if [ -z "$group" ] || [ -z "$version" ]; then
    fail "could not read GROUP and VERSION_NAME from android/gradle.properties"
  fi

  if [ "$skip_publish" -eq 0 ]; then
    # Publish into the SAME repo the assertions read from -- `-Dmaven.repo.local`
    # redirects Gradle's publishToMavenLocal target -- so a custom --repo is not
    # silently published to ~/.m2 and then checked (empty/stale) elsewhere.
    ( cd "${android_dir}" && ./gradlew :auto-mobile-sdk:publishToMavenLocal --stacktrace -Dmaven.repo.local="$repo" )
  fi

  local group_path="${group//.//}"
  local dir="${repo}/${group_path}/auto-mobile-sdk/${version}"
  [ -d "$dir" ] || fail "published module not found at ${dir} (did publishToMavenLocal run?)"

  local debug_aar="${dir}/auto-mobile-sdk-${version}-debug.aar"
  local release_aar="${dir}/auto-mobile-sdk-${version}-release.aar"
  local module="${dir}/auto-mobile-sdk-${version}.module"
  [ -f "$debug_aar" ] || fail "debug AAR missing: ${debug_aar} -- the SDK must publish the debug variant (#5714)"
  [ -f "$release_aar" ] || fail "release AAR missing: ${release_aar}"
  [ -f "$module" ] || fail "Gradle Module Metadata missing: ${module}"

  # Deliberately not `local`: a single EXIT trap cleans the dir on every path --
  # a normal return and the exit that fail() triggers alike. A RETURN trap would
  # leak on fail()'s exit, and a function-local would be gone (unbound under
  # set -u) by the time the EXIT trap runs after a normal return.
  tmp="$(mktemp -d)"
  trap 'rm -rf "${tmp:-}"' EXIT
  aar_entry "$debug_aar" AndroidManifest.xml >"${tmp}/debug-manifest.xml"
  aar_entry "$release_aar" AndroidManifest.xml >"${tmp}/release-manifest.xml"

  # Each helper is captured by assignment before it is tested: a bare
  # `func || fail` / `if func` puts the function in a condition where set -e is
  # suppressed, which the SC2310 ratchet (scripts/shellcheck/sete-baseline.txt)
  # gates. `[ ... ]` is a builtin, so testing the captured value is fine.
  local db_debug sp_debug db_class_debug sp_class_debug
  local db_release sp_release db_class_release sp_class_release

  # AC1 -- published debug AAR declares both exported inspection providers.
  db_debug="$(manifest_provider_count "${tmp}/debug-manifest.xml" "$DB_PROVIDER")"
  [ "$db_debug" = "1" ] || fail "AC1: debug AAR manifest does not declare exported ${DB_PROVIDER}"
  sp_debug="$(manifest_provider_count "${tmp}/debug-manifest.xml" "$SP_PROVIDER")"
  [ "$sp_debug" = "1" ] || fail "AC1: debug AAR manifest does not declare exported ${SP_PROVIDER}"

  # AC2 -- published debug AAR carries both provider classes.
  db_class_debug="$(aar_class_present "$debug_aar" "$DB_PROVIDER_CLASS")"
  [ "$db_class_debug" = "1" ] || fail "AC2: debug AAR classes.jar is missing ${DB_PROVIDER_CLASS}"
  sp_class_debug="$(aar_class_present "$debug_aar" "$SP_PROVIDER_CLASS")"
  [ "$sp_class_debug" = "1" ] || fail "AC2: debug AAR classes.jar is missing ${SP_PROVIDER_CLASS}"

  # AC3 -- published release AAR declares and packages neither inspection
  # provider. Scoped to the two providers by name (not "any provider present"),
  # so a legitimate release-safe provider added later under src/main does not
  # make this required job fail spuriously.
  db_release="$(manifest_named_provider_count "${tmp}/release-manifest.xml" "$DB_PROVIDER")"
  [ "$db_release" = "0" ] || fail "AC3: release AAR manifest declares ${DB_PROVIDER}; it must package neither inspection provider"
  sp_release="$(manifest_named_provider_count "${tmp}/release-manifest.xml" "$SP_PROVIDER")"
  [ "$sp_release" = "0" ] || fail "AC3: release AAR manifest declares ${SP_PROVIDER}; it must package neither inspection provider"
  db_class_release="$(aar_class_present "$release_aar" "$DB_PROVIDER_CLASS")"
  sp_class_release="$(aar_class_present "$release_aar" "$SP_PROVIDER_CLASS")"
  if [ "$db_class_release" != "0" ] || [ "$sp_class_release" != "0" ]; then
    fail "AC3: release AAR classes.jar contains an inspection provider class; it must package none"
  fi

  # AC4 -- module metadata routes each build type to the correct AAR.
  local debug_routed release_routed
  debug_routed="$(module_runtime_aar_for_build_type "$module" debug)"
  release_routed="$(module_runtime_aar_for_build_type "$module" release)"
  [ "$debug_routed" = "auto-mobile-sdk-${version}-debug.aar" ] \
    || fail "AC4: a debug consumer resolves '${debug_routed:-<none>}', expected the debug AAR"
  [ "$release_routed" = "auto-mobile-sdk-${version}-release.aar" ] \
    || fail "AC4: a release consumer resolves '${release_routed:-<none>}', expected the release AAR"

  echo "Published auto-mobile-sdk ${version} exposes the debug inspection providers to Maven consumers (debug), and none in release."
}

# Only orchestrate when executed; when sourced (BATS), expose the helpers only.
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  run_validation "$@"
fi
