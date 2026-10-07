#!/usr/bin/env bats
# bats file_tags=parallel-within-file
# All mutations are confined to BATS_TEST_TMPDIR; no serial tag is needed.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../../scripts/ci/commit-runtime-pins.sh"
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  REPO="$BATS_TEST_TMPDIR/work"
  export RUNTIME_PINS_PUSH_URL="$BATS_TEST_TMPDIR/origin.git"
  export PINS_DIR="$BATS_TEST_TMPDIR/pins"
  git init --bare -q "$RUNTIME_PINS_PUSH_URL"
  git init -q "$REPO"
  cd "$REPO"
  git config user.name test
  git config user.email test@example.com
  git config commit.gpgsign false
  mkdir -p scripts/release "$PINS_DIR/scripts/release"
  printf '{}\n' | tee package.json bun.lock scripts/release/runtime-graph.json >/dev/null
  printf 'untouched\n' > unrelated.txt
  git add -- package.json bun.lock scripts/release/runtime-graph.json unrelated.txt
  git commit -qm initial
  export HEAD_REF='dependabot/bun/example-1.2.3' TOKEN='test-token'
  export HEAD_SHA
  HEAD_SHA="$(git rev-parse HEAD)"
  git remote add origin "$RUNTIME_PINS_PUSH_URL"
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  for file in package.json bun.lock scripts/release/runtime-graph.json; do
    cp "$file" "$PINS_DIR/$file"
  done
}

remote_git() {
  git --git-dir="$RUNTIME_PINS_PUSH_URL" "$@"
}

remote_sha() {
  remote_git rev-parse "refs/heads/$HEAD_REF"
}

changed_pins() {
  printf '{"dependencies":{"updated":"1.0.0"}}\n' > "$PINS_DIR/package.json"
  printf '{"updated":true}\n' | tee "$PINS_DIR/bun.lock" "$PINS_DIR/scripts/release/runtime-graph.json" >/dev/null
}

assert_rejected() {
  [ "$status" -ne 0 ]
  [[ "$output" == *'::error::'* ]]
  [ "$(remote_sha)" = "$HEAD_SHA" ]
}

@test "no changes makes no commit or push" {
  export REAL_GIT PUSH_MARKER="$BATS_TEST_TMPDIR/push-ran"
  REAL_GIT="$(command -v git)"
  mkdir "$BATS_TEST_TMPDIR/bin"
  cat > "$BATS_TEST_TMPDIR/bin/git" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [[ "$arg" == push ]]; then touch "$PUSH_MARKER"; fi
done
exec "$REAL_GIT" "$@"
WRAPPER
  chmod +x "$BATS_TEST_TMPDIR/bin/git"
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *'No runtime pin changes'* ]]
  [ ! -e "$PUSH_MARKER" ]
  [ "$(remote_sha)" = "$HEAD_SHA" ]
}

@test "changed pins create exactly one fast-forward commit containing only pin files" {
  changed_pins
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  local new_sha
  new_sha="$(remote_sha)"
  [ "$(remote_git rev-list --count "$HEAD_SHA..$new_sha")" -eq 1 ]
  [ "$(remote_git rev-parse "$new_sha^")" = "$HEAD_SHA" ]
  [ "$(remote_git diff-tree --no-commit-id --name-only -r "$new_sha")" = $'bun.lock\npackage.json\nscripts/release/runtime-graph.json' ]
  [ "$(remote_git show "$new_sha:unrelated.txt")" = untouched ]
  [ "$(remote_git show -s --format='%an <%ae>' "$new_sha")" = 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>' ]
}

@test "artifact package scripts cannot change from the PR head" {
  printf '{"scripts":{"postinstall":"curl evil"}}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'package.json'* ]]
}

@test "artifact package name and bin cannot change from the PR head" {
  for tampered in '{"name":"evil"}' '{"bin":{"evil":"evil.sh"}}'; do
    printf '%s\n' "$tampered" > "$PINS_DIR/package.json"
    run bash "$SCRIPT"
    assert_rejected
    [[ "$output" == *'package.json'* ]]
  done
}

@test "artifact trustedDependencies cannot change from the PR head" {
  printf '{"trustedDependencies":["evil"]}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'Artifact package.json changed fields outside the allowed dependency keys.'* ]]
}

@test "artifact overrides cannot change from the PR head" {
  printf '{"overrides":{"a":"1.0.1"}}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'Artifact package.json changed fields outside the allowed dependency keys.'* ]]
}

@test "artifact resolutions cannot change from the PR head" {
  printf '{"resolutions":{"a":"1.0.1"}}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'Artifact package.json changed fields outside the allowed dependency keys.'* ]]
}

@test "artifact optionalDependencies cannot change from the PR head" {
  printf '{"optionalDependencies":{"a":"1.0.1"}}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'Artifact package.json changed fields outside the allowed dependency keys.'* ]]
}

@test "artifact peerDependencies cannot change from the PR head" {
  printf '{"peerDependencies":{"a":"1.0.1"}}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'Artifact package.json changed fields outside the allowed dependency keys.'* ]]
}

@test "dependency version changes are accepted and pushed" {
  printf '{"dependencies":{"a":"1.0.0"}}\n' > package.json
  git add -- package.json
  git commit -qm 'dependency before pin regeneration'
  HEAD_SHA="$(git rev-parse HEAD)"
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  printf '{"dependencies":{"a":"1.0.1"}}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(remote_sha)" != "$HEAD_SHA" ]
  [ "$(remote_git show "$(remote_sha):package.json")" = '{"dependencies":{"a":"1.0.1"}}' ]
}

@test "devDependency version changes are accepted and pushed" {
  printf '{"devDependencies":{"a":"1.0.0"}}\n' > package.json
  git add -- package.json
  git commit -qm 'devDependency before pin regeneration'
  HEAD_SHA="$(git rev-parse HEAD)"
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  printf '{"devDependencies":{"a":"1.0.1"}}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(remote_sha)" != "$HEAD_SHA" ]
  [ "$(remote_git show "$(remote_sha):package.json")" = '{"devDependencies":{"a":"1.0.1"}}' ]
}

@test "a new transitive dependency pin is accepted and pushed" {
  # Pin rewrites legitimately add/remove/move names: repartitionDependencies in
  # scripts/release/lib/runtime-pins.ts promotes closure pins into dependencies
  # and moves entries to devDependencies. Name-set changes within the three
  # written keys are NOT rejected; this is deliberate.
  printf '{"dependencies":{"a":"1.0.0"}}\n' > package.json
  git add -- package.json
  git commit -qm 'dependency before closure pin addition'
  HEAD_SHA="$(git rev-parse HEAD)"
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  printf '{"dependencies":{"a":"1.0.0","transitive":"2.0.0"}}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(remote_sha)" != "$HEAD_SHA" ]
  [ "$(remote_git show "$(remote_sha):package.json")" = '{"dependencies":{"a":"1.0.0","transitive":"2.0.0"}}' ]
}

@test "package comparison ignores formatting and object key order" {
  printf '{"name":"safe","scripts":{"test":"bun test","build":"bun run build"}}\n' > package.json
  git add -- package.json
  git commit -qm 'package metadata'
  HEAD_SHA="$(git rev-parse HEAD)"
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  printf '{\n "scripts": {"build":"bun run build", "test":"bun test"},\n "name": "safe",\n "dependencies": {"a":"1.0.1"}\n}\n' > "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(remote_sha)" != "$HEAD_SHA" ]
}

@test "PR head without package.json is rejected" {
  git rm -q package.json
  git commit -qm 'missing package'
  HEAD_SHA="$(git rev-parse HEAD)"
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  changed_pins
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'package.json'* ]]
}

@test "extra paths including dotfiles and directories are rejected" {
  for extra in extra.txt .hidden extra-dir; do
    if [[ "$extra" == extra-dir ]]; then mkdir "$PINS_DIR/$extra"; else touch "$PINS_DIR/$extra"; fi
    run bash "$SCRIPT"
    assert_rejected
    [[ "$output" == *'Unexpected artifact path'* ]]
    rm -rf "$PINS_DIR/$extra"
  done
}

@test "symlinks including expected pin files and directories are rejected" {
  ln -s "$REPO/package.json" "$PINS_DIR/link"
  run bash "$SCRIPT"
  assert_rejected
  rm "$PINS_DIR/link" "$PINS_DIR/package.json"
  ln -s "$REPO/package.json" "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  assert_rejected
  cp "$REPO/package.json" "$BATS_TEST_TMPDIR/package.json"
  rm "$PINS_DIR/package.json"
  cp "$BATS_TEST_TMPDIR/package.json" "$PINS_DIR/package.json"
  rm -rf "$PINS_DIR/scripts"
  ln -s "$REPO/scripts" "$PINS_DIR/scripts"
  run bash "$SCRIPT"
  assert_rejected
}

@test "hardlinked pin files are rejected" {
  rm "$PINS_DIR/package.json"
  ln "$REPO/package.json" "$PINS_DIR/package.json"
  run bash "$SCRIPT"
  assert_rejected
}

@test "invalid empty or multiple JSON documents are rejected for both JSON files" {
  for file in package.json scripts/release/runtime-graph.json; do
    for invalid in not-json '' '{} {}' '[]'; do
      printf '%s' "$invalid" > "$PINS_DIR/$file"
      run bash "$SCRIPT"
      assert_rejected
      [[ "$output" == *'must contain one JSON object'* ]]
    done
    printf '{}\n' > "$PINS_DIR/$file"
  done
}

@test "missing pin files and oversized pin files are rejected" {
  rm "$PINS_DIR/bun.lock"
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'Missing runtime pin file'* ]]
  printf 'oversized' > "$PINS_DIR/bun.lock"
  export RUNTIME_PINS_MAX_BYTES=4
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'exceeds size cap'* ]]
}

@test "remote head moved fails without pushing" {
  git -c user.name=test -c user.email=test@example.com commit --allow-empty -qm newer
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  local newer_sha
  newer_sha="$(remote_sha)"
  changed_pins
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *'::error::Remote PR head moved'* ]]
  [ "$(remote_sha)" = "$newer_sha" ]
}

@test "missing token clearly identifies the required Dependabot secret" {
  unset TOKEN
  run bash "$SCRIPT"
  assert_rejected
  [[ "$output" == *'::error::Missing AUTO_MOBILE_PR_TOKEN'* ]]
  [[ "$output" == *'Dependabot secrets store'* ]]
  [[ "$output" == *'Actions secrets store'* ]]
}

@test "malicious template hooks config and PR symlinks cannot execute or redirect writes" {
  export GIT_TEMPLATE_DIR="$BATS_TEST_TMPDIR/template"
  export HOOK_MARKER="$BATS_TEST_TMPDIR/hook-ran"
  mkdir -p "$GIT_TEMPLATE_DIR/hooks"
  for hook in pre-commit pre-push post-commit; do
    printf '#!/usr/bin/env bash\ntouch "$HOOK_MARKER"\n' > "$GIT_TEMPLATE_DIR/hooks/$hook"
    chmod +x "$GIT_TEMPLATE_DIR/hooks/$hook"
  done
  printf '[core]\n hooksPath = %s/hooks\n fsmonitor = %s/hooks/pre-commit\n' "$GIT_TEMPLATE_DIR" "$GIT_TEMPLATE_DIR" > "$GIT_TEMPLATE_DIR/config"
  # A checkout would materialize these paths. The trusted script uses the index
  # only, so neither the template config nor PR symlinks affect copying/staging.
  rm bun.lock
  ln -s .git/config bun.lock
  printf 'package.json working-tree-encoding=UTF-16\n' > .gitattributes
  git add -- bun.lock .gitattributes
  git commit -qm 'malicious PR paths'
  HEAD_SHA="$(git rev-parse HEAD)"
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  changed_pins
  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ ! -e "$HOOK_MARKER" ]
  local new_sha
  new_sha="$(remote_sha)"
  [ "$(remote_git show "$new_sha:package.json")" = '{"dependencies":{"updated":"1.0.0"}}' ]
  [ "$(remote_git show "$new_sha:bun.lock")" = '{"updated":true}' ]
  [ "$(remote_git diff-tree --no-commit-id --name-only -r "$new_sha")" = $'bun.lock\npackage.json\nscripts/release/runtime-graph.json' ]
}

@test "PR directory symlink fails safely without pushing" {
  rm -rf scripts
  ln -s .git scripts
  git add -- scripts
  git commit -qm 'malicious PR directory'
  HEAD_SHA="$(git rev-parse HEAD)"
  git push -q origin HEAD:refs/heads/"$HEAD_REF"
  changed_pins
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(remote_sha)" = "$HEAD_SHA" ]
}

@test "auth header uses environment only and is absent from git files and ordinary logs" {
  changed_pins
  export REAL_GIT HEADER_MARKER="$BATS_TEST_TMPDIR/header-checked"
  REAL_GIT="$(command -v git)"
  mkdir "$BATS_TEST_TMPDIR/bin"
  cat > "$BATS_TEST_TMPDIR/bin/git" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
[[ "$GIT_CONFIG_COUNT" == 1 ]]
[[ "$GIT_CONFIG_KEY_0" == http.https://github.com/.extraheader ]]
encoded="$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
[[ "$GIT_CONFIG_VALUE_0" == "AUTHORIZATION: basic $encoded" ]]
for arg in "$@"; do
  [[ "$arg" != *"$TOKEN"* && "$arg" != *"$encoded"* ]]
done
"$REAL_GIT" "$@"
if [[ -d .git ]]; then
  if grep -R -F -e "$TOKEN" -e "$encoded" .git >/dev/null; then
    echo 'credential persisted' >&2
    exit 1
  fi
fi
touch "$HEADER_MARKER"
WRAPPER
  chmod +x "$BATS_TEST_TMPDIR/bin/git"
  run env PATH="$BATS_TEST_TMPDIR/bin:$PATH" bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -e "$HEADER_MARKER" ]
  # Mask directives necessarily contain both secrets; Actions consumes them to
  # redact subsequent logs. BATS is not an Actions log-redaction service.
  local ordinary_logs encoded
  ordinary_logs="$(printf '%s\n' "$output" | sed '/^::add-mask::/d')"
  encoded="$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
  [[ "$ordinary_logs" != *"$TOKEN"* && "$ordinary_logs" != *"$encoded"* ]]
  [ "$(remote_sha)" != "$HEAD_SHA" ]
}
