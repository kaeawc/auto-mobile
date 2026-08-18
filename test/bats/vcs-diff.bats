#!/usr/bin/env bats

setup() {
  repo_dir="$(mktemp -d)"
  mkdir -p "$repo_dir/.jj" "$repo_dir/bin" "$repo_dir/scripts/lib"
  cp "$BATS_TEST_DIRNAME/../../scripts/lib/vcs-diff.sh" "$repo_dir/scripts/lib/"
  cat > "$repo_dir/bin/jj" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  log)
    exit 0
    ;;
  diff)
    if [[ " $* " == *" --name-only "* ]]; then
      printf '%s\n' "src/changed.ts"
    else
      printf '%s\n' "+const changed = true;"
    fi
    ;;
esac
EOF
  chmod +x "$repo_dir/bin/jj"
}

teardown() {
  rm -rf "$repo_dir"
}

@test "uses the main@origin bookmark and jj diff in a jj workspace" {
  run bash -c 'cd "$1" && PATH="$1/bin:$PATH" && source scripts/lib/vcs-diff.sh && vcs_base_ref origin/main && vcs_base_exists origin/main && vcs_changed_files origin/main src && vcs_changed_files_since_merge_base origin/main src && vcs_diff origin/main src/changed.ts && vcs_diff_since_merge_base origin/main src/changed.ts' _ "$repo_dir"

  [ "$status" -eq 0 ]
  [[ "$output" == *"main@origin"* ]]
  [[ "$output" == *"src/changed.ts"* ]]
  [[ "$output" == *"+const changed = true;"* ]]
}
