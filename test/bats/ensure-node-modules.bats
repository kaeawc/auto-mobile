#!/usr/bin/env bats
#
# Pins ensure_node_modules() in scripts/lib/shell-core.sh (issue #5051): it must
# no-op when node_modules/.bin/turbo already exists, and run
# `bun install --frozen-lockfile` when it doesn't. `bun` is mocked on PATH so no
# real install runs.

LIB="scripts/lib/shell-core.sh"

@test "ensure_node_modules is a no-op when node_modules/.bin/turbo exists" {
  local root bindir
  root="$(mktemp -d)"
  mkdir -p "$root/node_modules/.bin"
  : > "$root/node_modules/.bin/turbo"
  chmod +x "$root/node_modules/.bin/turbo"
  # A bun that fails loudly if called — the no-op path must not invoke it.
  bindir="$(mktemp -d)"
  printf '#!/usr/bin/env bash\necho CALLED_BUN\nexit 3\n' > "$bindir/bun"
  chmod +x "$bindir/bun"

  run env PATH="$bindir:$PATH" bash -c "source '$LIB'; ensure_node_modules '$root'"
  rm -rf "$root" "$bindir"

  [ "$status" -eq 0 ]
  [[ "$output" != *"CALLED_BUN"* ]]
}

@test "ensure_node_modules installs with --frozen-lockfile when turbo is absent" {
  local root bindir
  root="$(mktemp -d)"   # no node_modules
  bindir="$(mktemp -d)"
  # A bun that echoes its args so we can assert the exact install invocation.
  printf '#!/usr/bin/env bash\necho "bun $*"\n' > "$bindir/bun"
  chmod +x "$bindir/bun"

  run env PATH="$bindir:$PATH" bash -c "source '$LIB'; ensure_node_modules '$root'"
  rm -rf "$root" "$bindir"

  [ "$status" -eq 0 ]
  [[ "$output" == *"bun install --frozen-lockfile"* ]]
}

@test "ensure_node_modules leaves the caller's working directory unchanged" {
  local root bindir start
  root="$(mktemp -d)"
  bindir="$(mktemp -d)"
  printf '#!/usr/bin/env bash\ntrue\n' > "$bindir/bun"
  chmod +x "$bindir/bun"
  start="$PWD"

  run env PATH="$bindir:$PATH" bash -c "source '$LIB'; ensure_node_modules '$root'; pwd"
  rm -rf "$root" "$bindir"

  [ "$status" -eq 0 ]
  [[ "$output" == *"$start"* ]]
}
