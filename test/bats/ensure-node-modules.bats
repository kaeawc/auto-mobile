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

@test "ensure_node_modules installs with --frozen-lockfile in root when turbo is absent" {
  local root bindir
  root="$(cd "$(mktemp -d)" && pwd)"   # no node_modules; canonicalized (macOS /var -> /private)
  bindir="$(mktemp -d)"
  # A bun that echoes its CWD and args, so we assert both the exact install
  # invocation AND that it runs in root (removing the `cd "$root"` must fail this).
  printf '#!/usr/bin/env bash\necho "bun_cwd=$PWD"\necho "bun $*"\n' > "$bindir/bun"
  chmod +x "$bindir/bun"

  run env PATH="$bindir:$PATH" bash -c "source '$LIB'; ensure_node_modules '$root'"
  rm -rf "$root" "$bindir"

  [ "$status" -eq 0 ]
  [[ "$output" == *"bun install --frozen-lockfile"* ]]
  [[ "$output" == *"bun_cwd=$root"* ]]
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
