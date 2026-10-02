#!/usr/bin/env bash
# Trusted default-branch code only. Inputs: TOKEN, HEAD_REF, HEAD_SHA,
# GITHUB_REPOSITORY, PINS_DIR. Local tests can override RUNTIME_PINS_CLONE_URL,
# RUNTIME_PINS_PUSH_URL and RUNTIME_PINS_MAX_BYTES; never set these from PR data.
# Artifact package.json may change only dependency fields from the verified PR head.
set -euo pipefail

if [[ -z "${TOKEN:-}" ]]; then
  echo '::error::Missing AUTO_MOBILE_PR_TOKEN. A repository owner must configure it in both the Dependabot secrets store (Dependabot-actor runs) and the Actions secrets store (maintainer re-runs).'
  exit 1
fi
printf '::add-mask::%s\n' "$TOKEN"
auth="$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
printf '::add-mask::%s\n' "$auth"
: "${HEAD_REF:?HEAD_REF is required}" "${HEAD_SHA:?HEAD_SHA is required}" "${PINS_DIR:?PINS_DIR is required}"

command -v git >/dev/null || { echo '::error::git is required.'; exit 1; }
command -v jq >/dev/null || { echo '::error::jq is required to validate runtime pin JSON.'; exit 1; }
# Ignore inherited config, helpers, hooks and template configuration. The header
# lives only in process environment: never in argv, remote URLs or .git/config.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0
unset GIT_CONFIG_PARAMETERS GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
run_git() {
  git -c core.hooksPath=/dev/null -c core.fsmonitor=false \
    -c protocol.ext.allow=never -c credential.helper= -c commit.gpgsign=false "$@"
}
run_git check-ref-format "refs/heads/$HEAD_REF"
if [[ ! "$HEAD_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo '::error::HEAD_SHA must be a full commit SHA.'
  exit 1
fi

if [[ ! -d "$PINS_DIR" || -L "$PINS_DIR" ]]; then
  echo '::error::Artifact must be a regular directory.'
  exit 1
fi
PINS_DIR="$(cd "$PINS_DIR" && pwd -P)"
# 20 MiB per file comfortably exceeds the current lockfile/JSON sizes while
# bounding privileged parsing/copying. The override makes size tests cheap.
max_bytes="${RUNTIME_PINS_MAX_BYTES:-20971520}"
if [[ ! "$max_bytes" =~ ^[1-9][0-9]{0,8}$ ]]; then
  echo '::error::Invalid runtime pin size cap.'
  exit 1
fi
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
# Materialize find output so traversal errors fail rather than being lost in a
# process substitution. NUL delimiters include dotfiles and unusual filenames.
find "$PINS_DIR" -mindepth 1 -print0 > "$work_dir/entries"
while IFS= read -r -d '' entry; do
  relative="${entry#"$PINS_DIR/"}"
  case "$relative" in
    scripts|scripts/release)
      [[ -d "$entry" && ! -L "$entry" ]] || { echo '::error::Invalid artifact directory.'; exit 1; }
      ;;
    package.json|bun.lock|scripts/release/runtime-graph.json)
      # find -links is portable across BSD and GNU; reject shared inodes too.
      if [[ ! -f "$entry" || -L "$entry" ]] || [[ -n "$(find "$entry" -type f -links +1 -print)" ]]; then
        echo '::error::Artifact pin files must be regular files without links.'
        exit 1
      fi
      bytes="$(wc -c < "$entry")"
      if (( bytes > max_bytes )); then
        echo '::error::Artifact pin file exceeds size cap.'
        exit 1
      fi
      ;;
    *) echo '::error::Unexpected artifact path outside the three runtime pin files.'; exit 1 ;;
  esac
done < "$work_dir/entries"
for file in package.json bun.lock scripts/release/runtime-graph.json; do
  [[ -f "$PINS_DIR/$file" ]] || { echo '::error::Missing runtime pin file in artifact.'; exit 1; }
done
for file in package.json scripts/release/runtime-graph.json; do
  # Exactly one JSON object, not an empty input or concatenated JSON documents.
  if ! jq -e -s 'length == 1 and (.[0] | type == "object")' "$PINS_DIR/$file" >/dev/null 2>&1; then
    echo '::error::Artifact package.json and runtime-graph.json must contain one JSON object.'
    exit 1
  fi
done

clone_url="${RUNTIME_PINS_CLONE_URL:-${RUNTIME_PINS_PUSH_URL:-https://github.com/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}.git}}"
push_url="${RUNTIME_PINS_PUSH_URL:-$clone_url}"
mkdir "$work_dir/repo"
cd "$work_dir/repo"
run_git init --quiet --template=
run_git fetch --quiet --depth=1 --no-tags "$clone_url" "refs/heads/$HEAD_REF"
remote_head="$(run_git rev-parse FETCH_HEAD)"
if [[ "$remote_head" != "$HEAD_SHA" ]]; then
  echo '::error::Remote PR head moved since this job started; refusing to push runtime pins.'
  exit 1
fi
head_package_path="$(run_git ls-tree --name-only "$HEAD_SHA" -- package.json)"
if [[ "$head_package_path" != package.json ]]; then
  echo '::error::PR head must contain package.json; refusing to push runtime pins.'
  exit 1
fi
run_git show "$HEAD_SHA:package.json" > "$work_dir/head-package.json"
# scripts/release/pin-runtime-deps.ts writeMode() is the source of truth for
# these written keys; update both together. Canonical JSON ignores formatter changes.
package_keys='["dependencies","devDependencies","bundledDependencies"]'
# $keys is a jq variable, not a shell expansion.
# shellcheck disable=SC2016
package_filter='delpaths($keys | map([.]))'
if ! head_package="$(jq -S -c --argjson keys "$package_keys" "$package_filter" "$work_dir/head-package.json")" ||
   ! artifact_package="$(jq -S -c --argjson keys "$package_keys" "$package_filter" "$PINS_DIR/package.json")"; then
  echo '::error::Unable to compare artifact package.json with the PR head.'
  exit 1
fi
if [[ "$artifact_package" != "$head_package" ]]; then
  echo '::error::Artifact package.json changed fields outside the allowed dependency keys.'
  exit 1
fi
# Accepting regenerated bun.lock data beyond the existing checks is an owner decision.
# Populate HEAD/index only, never the PR working tree. This avoids PR-controlled
# symlinks, .gitattributes filters and scripts when copying/staging the artifact.
run_git reset --quiet --mixed "$HEAD_SHA"
mkdir -p scripts/release
for file in package.json bun.lock scripts/release/runtime-graph.json; do
  cp "$PINS_DIR/$file" "$file"
  # Stage bytes directly: git add can read PR .gitattributes from the index even
  # without a checkout. No filters/encoding conversions may touch artifact data.
  blob="$(run_git hash-object -w --no-filters -- "$file")"
  run_git update-index --add --cacheinfo "100644,$blob,$file"
done
changed_files="$(run_git diff --cached --name-only)"
if [[ -z "$changed_files" ]]; then
  echo '::notice::No runtime pin changes to commit.'
  exit 0
fi
run_git -c user.name='github-actions[bot]' \
  -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
  commit -m 'chore(deps): regenerate pinned runtime graph [dependabot]'
# No skip-ci marker. A concurrent branch update is rejected by fast-forward push.
run_git push "$push_url" HEAD:refs/heads/"$HEAD_REF"
