#!/usr/bin/env bats
#
# scripts/update-tool-definitions.sh (the pre-commit hook body) must install the
# locked dependency graph when node_modules is missing and must never let bun
# auto-install the latest zod into its global cache (Zod 4 breaks the overlay
# tool schema conversion: "Custom types cannot be represented in JSON Schema").

setup() {
  REAL_SCRIPT="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)/scripts/update-tool-definitions.sh"
  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$TMP_ROOT/scripts" "$TMP_ROOT/stubs"
  cp "$REAL_SCRIPT" "$TMP_ROOT/scripts/"
  cat > "$TMP_ROOT/stubs/bun" <<'STUB'
#!/usr/bin/env bash
echo "bun $*" >> "$STUB_LOG"
if [[ "$1" == "install" ]]; then
  mkdir -p node_modules/zod && echo '{}' > node_modules/zod/package.json
fi
STUB
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP_ROOT/stubs/bunx"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP_ROOT/stubs/git"
  chmod +x "$TMP_ROOT/stubs/bun" "$TMP_ROOT/stubs/bunx" "$TMP_ROOT/stubs/git"
  export STUB_LOG="$TMP_ROOT/log"
}

teardown() {
  rm -rf "$TMP_ROOT"
}

@test "no-stage generates without any git commands" {
  printf '#!/usr/bin/env bash\necho "unexpected git $*" >> "$STUB_LOG"\nexit 1\n' > "$TMP_ROOT/stubs/git"
  PATH="$TMP_ROOT/stubs:$PATH" run bash "$TMP_ROOT/scripts/update-tool-definitions.sh" --no-stage
  [ "$status" -eq 0 ]
  [[ "$output" == *"without staging"* ]]
  run cat "$STUB_LOG"
  [[ "$output" != *"unexpected git"* ]]
}

@test "installs the frozen lockfile when node_modules is missing, then generates without auto-install" {
  PATH="$TMP_ROOT/stubs:$PATH" run bash "$TMP_ROOT/scripts/update-tool-definitions.sh"
  [ "$status" -eq 0 ]
  run cat "$STUB_LOG"
  [ "${lines[0]}" = "bun install --frozen-lockfile" ]
  [ "${lines[1]}" = "bun --no-install scripts/generate-tool-definitions.ts" ]
}

@test "skips install when node_modules is present" {
  mkdir -p "$TMP_ROOT/node_modules/zod" && echo '{}' > "$TMP_ROOT/node_modules/zod/package.json"
  PATH="$TMP_ROOT/stubs:$PATH" run bash "$TMP_ROOT/scripts/update-tool-definitions.sh"
  [ "$status" -eq 0 ]
  run cat "$STUB_LOG"
  [ "${lines[0]}" = "bun --no-install scripts/generate-tool-definitions.ts" ]
}

@test "formats and stages only the docs pages the generator lists" {
  mkdir -p "$TMP_ROOT/node_modules/zod" && echo '{}' > "$TMP_ROOT/node_modules/zod/package.json"
  cat > "$TMP_ROOT/stubs/bun" <<'STUB'
#!/usr/bin/env bash
echo "bun $*" >> "$STUB_LOG"
if [[ " $* " == *" --list-docs "* ]]; then
  printf 'docs/tools.md\ndocs/using/observe.md\n'
fi
STUB
  printf '#!/usr/bin/env bash\necho "bunx $*" >> "$STUB_LOG"\n' > "$TMP_ROOT/stubs/bunx"
  # git diff --quiet reports a change, so the script reaches git add.
  printf '#!/usr/bin/env bash\necho "git $*" >> "$STUB_LOG"\n[[ " $* " == *" diff "* ]] && exit 1\nexit 0\n' > "$TMP_ROOT/stubs/git"
  chmod +x "$TMP_ROOT/stubs/bun" "$TMP_ROOT/stubs/bunx" "$TMP_ROOT/stubs/git"
  PATH="$TMP_ROOT/stubs:$PATH" run bash "$TMP_ROOT/scripts/update-tool-definitions.sh"
  [ "$status" -eq 0 ]
  run grep -E '^(bunx|git .* add)' "$STUB_LOG"
  [[ "$output" == *"bunx oxfmt schemas/tool-definitions.json docs/tools.md docs/using/observe.md"* ]]
  [[ "$output" == *"add -- schemas/tool-definitions.json docs/tools.md docs/using/observe.md"* ]]
  [[ "$output" != *"docs/using "* && "$output" != *"docs/using"$'\n'* ]]
}

@test "collects the listed docs without mapfile or readarray (macOS Bash 3.2)" {
  run grep -nE '\b(mapfile|readarray)\b' "$REAL_SCRIPT"
  [ "$status" -eq 1 ]
  mkdir -p "$TMP_ROOT/node_modules/zod" && echo '{}' > "$TMP_ROOT/node_modules/zod/package.json"
  cat > "$TMP_ROOT/stubs/bun" <<'STUB'
#!/usr/bin/env bash
if [[ " $* " == *" --list-docs "* ]]; then
  printf 'docs/tools.md\ndocs/using/observe.md\n'
fi
STUB
  printf '#!/usr/bin/env bash\necho "bunx $*" >> "$STUB_LOG"\n' > "$TMP_ROOT/stubs/bunx"
  chmod +x "$TMP_ROOT/stubs/bun" "$TMP_ROOT/stubs/bunx"
  # Disable the builtins Bash 3.2 lacks, then run the script in that shell.
  PATH="$TMP_ROOT/stubs:$PATH" run bash -c 'enable -n mapfile readarray; . "$0" "$@"' \
    "$TMP_ROOT/scripts/update-tool-definitions.sh" --no-stage
  [ "$status" -eq 0 ]
  [[ "$output" == *"without staging"* ]]
  run cat "$STUB_LOG"
  [[ "$output" == *"bunx oxfmt schemas/tool-definitions.json docs/tools.md docs/using/observe.md"* ]]
}
