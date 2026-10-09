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
