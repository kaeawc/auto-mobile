#!/usr/bin/env bash
# Select which Android modules need `lintDebug` for a set of changed files.
#
# Shared by scripts/prepush-android.sh and the PR Detekt job so the selection
# cannot drift. Reads changed repo-relative paths on stdin (one per line) and
# prints either the single word `all` or one Gradle task per line
# (`:control-proxy:lintDebug`). Prints nothing when no module needs linting.
#
#   sources, resources, manifests, lint baselines -> the owner and transitive Android consumers
#   build-logic, Gradle wiring, a module build script, the lint gate scripts or
#   the workflows that run lint                    -> all
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: git diff --no-renames --name-only <base>...HEAD | scripts/android/select-lint-modules.sh

Run from the repository root. Prints `all`, or the `:module:lintDebug` tasks for
the owning Android modules and their transitive Android consumers. JVM modules
participate in dependency traversal but never receive lintDebug tasks.
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

lint_all=false
modules=()
while IFS= read -r changed_file; do
  [[ -n "$changed_file" ]] || continue
  case "$changed_file" in
    scripts/android/check-lint-baseline-shrink.sh|scripts/android/select-lint-modules.sh|scripts/prepush-android.sh|.github/workflows/pull_request.yml|.github/workflows/merge.yml|.github/actions/gradle-task-run/*)
      lint_all=true
      ;;
    android/build-logic/*|android/build.gradle.kts|android/settings.gradle.kts|android/gradle.properties|android/gradle/*|android/gradlew|android/gradlew.bat)
      lint_all=true
      ;;
    android/**/build.gradle.kts|android/**/gradle.properties)
      lint_all=true
      ;;
    android/**/src/*|android/**/lint-baseline.xml)
      module_dir="$(dirname "$changed_file")"
      while [[ "$module_dir" != android && ! -f "$module_dir/build.gradle.kts" ]]; do
        module_dir="$(dirname "$module_dir")"
      done
      if [[ "$module_dir" != android ]]; then
        module_path=":${module_dir#android/}"
        modules+=("${module_path//\//:}")
      fi
      ;;
  esac
done

if [[ "$lint_all" == true ]]; then
  echo all
elif [[ "${#modules[@]}" -gt 0 ]]; then
  # Parse only the repository's declarative include/project dependency forms,
  # not arbitrary Kotlin. Settings names define Gradle's typesafe accessor map.
  # Unknown accessors fail safe to all; cycles terminate at the fixed point.
  build_files=()
  while IFS= read -r build_file; do
    build_files+=("$build_file")
  done < <(find android -name build.gradle.kts -not -path '*/build/*' -not -path '*/.gradle/*' | sort)
  settings=()
  [[ ! -f android/settings.gradle.kts ]] || settings+=(android/settings.gradle.kts)
  awk -v seeds="$(printf '%s ' ${modules[@]+"${modules[@]}"})" '
    function accessor(path, parts, words, n, m, i, j, result, segment) {
      n = split(substr(path, 2), parts, ":")
      result = "projects"
      for (i = 1; i <= n; i++) {
        m = split(parts[i], words, /[-_]/)
        segment = words[1]
        for (j = 2; j <= m; j++)
          segment = segment toupper(substr(words[j], 1, 1)) substr(words[j], 2)
        result = result "." segment
      }
      return result
    }
    BEGIN {
      n = split(seeds, paths, " ")
      for (i = 1; i <= n; i++) selected[paths[i]] = 1
    }
    FILENAME == "android/settings.gradle.kts" {
      line = $0
      sub(/\/\/.*/, "", line)
      if (line ~ /include[[:space:]]*\(/) in_include = 1
      if (in_include) {
        rest = line
        while (match(rest, /"(:[A-Za-z0-9_:-]+)"/)) {
          path = substr(rest, RSTART + 1, RLENGTH - 2)
          names[accessor(path)] = path
          rest = substr(rest, RSTART + RLENGTH)
        }
        if (line ~ /\)/) in_include = 0
      }
      next
    }
    {
      module = FILENAME
      sub(/^android\//, ":", module)
      sub(/\/build.gradle.kts$/, "", module)
      gsub(/\//, ":", module)
      if ($0 ~ /alias\(libs\.plugins\.android\.(application|library)\)|id\("automobile\.android-(library|application)"\)/)
        android[module] = 1
      line = $0
      sub(/\/\/.*/, "", line)
      sources[module] = sources[module] line "\n"
    }
    END {
      for (module in sources) {
        rest = sources[module]
        while (match(rest, /projects\.[A-Za-z0-9_.]+/)) {
          name = substr(rest, RSTART, RLENGTH)
          if (!(name in names)) unknown = 1
          else edges[module SUBSEP names[name]] = 1
          rest = substr(rest, RSTART + RLENGTH)
        }
        rest = sources[module]
        while (match(rest, /project[[:space:]]*\([[:space:]]*"(:[A-Za-z0-9_:-]+)"/)) {
          path = substr(rest, RSTART, RLENGTH)
          sub(/^[^"]*"/, "", path)
          sub(/"$/, "", path)
          edges[module SUBSEP path] = 1
          rest = substr(rest, RSTART + RLENGTH)
        }
      }
      if (unknown) { print "all"; exit }
      do {
        changed = 0
        for (edge in edges) {
          split(edge, pair, SUBSEP)
          if (selected[pair[2]] && !selected[pair[1]]) {
            selected[pair[1]] = 1
            changed = 1
          }
        }
      } while (changed)
      for (module in selected)
        if (selected[module] && android[module]) print module ":lintDebug"
    }
  ' ${settings[@]+"${settings[@]}"} ${build_files[@]+"${build_files[@]}"} | sort -u
fi
