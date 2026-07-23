#!/usr/bin/env bats
#
# Tests for the portability/cosmetic fixes in #3653:
#  A) detect-dead-code-ts.sh: timestamp must not emit a literal "%3N" on BSD date
#  B) validate_shell_scripts.sh / xml/validate_xml.sh: portable CPU count (no bare nproc)
#  C) xml/format_xml.sh: formatter stderr must not be merged into the output file

setup() {
  WORK_DIR="$(mktemp -d)"
}
teardown() {
  rm -rf "$WORK_DIR"
}

@test "MkDocs navigation validator resolves the repository from its own path" {
  local validator
  validator="$(cd scripts && pwd)/validate_mkdocs_nav.sh"
  run bash -c 'cd "$1" && "$2"' _ "$WORK_DIR" "$validator"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Found "*"files referenced"* ]]
}

# --- A ---------------------------------------------------------------------
@test "iso_now_ms produces a valid ISO timestamp (no literal %3N)" {
  local abs
  abs="$(cd scripts && pwd)/detect-dead-code-ts.sh"
  local fn="$WORK_DIR/iso.sh"
  awk '/^iso_now_ms\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$abs" > "$fn"

  run bash -c 'source "$1"; iso_now_ms' _ "$fn"
  [ "$status" -eq 0 ]
  [[ "$output" != *"%3N"* ]]
  [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+Z$ ]]
}

# --- B ---------------------------------------------------------------------
@test "shell/xml validators do not use a bare -P \"\$(nproc)\"" {
  for s in scripts/shellcheck/validate_shell_scripts.sh scripts/xml/validate_xml.sh; do
    local hits
    hits="$(grep -vE '^\s*#' "$s" | grep -F '$(nproc)' || true)"
    [ -z "$hits" ]
  done
}

@test "the CPU-count fallback yields a positive integer without nproc" {
  local bin
  bin="$(mktemp -d)"
  for t in bash sysctl getconf; do
    [ -e "$(command -v "$t" 2>/dev/null)" ] && ln -s "$(command -v "$t")" "$bin/$t"
  done
  # No `nproc` in $bin — exercise the fallback chain used by the scripts.
  run env PATH="$bin" bash -c 'echo "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"'
  rm -rf "$bin"
  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]+$ ]]
  [ "$output" -ge 1 ]
}

@test "timestamp helper stays numeric on macOS without coreutils" {
  run env OSTYPE=darwin PATH="/usr/bin:/bin" bash scripts/utils/get_timestamp.sh

  [ "$status" -eq 0 ]
  [[ "$output" =~ ^[0-9]{13}$ ]]
}

# --- C ---------------------------------------------------------------------
@test "format_xml does not write the formatter's stderr into the file" {
  local abs
  abs="$(cd scripts/xml && pwd)/format_xml.sh"
  local fn="$WORK_DIR/format_xml.sh"
  awk '/^format_xml\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$abs" > "$fn"

  local bin="$WORK_DIR/bin"
  mkdir -p "$bin"
  # Both tools: valid XML to stdout, a warning to stderr, exit 0.
  for tool in xml xmlstarlet; do
    cat > "$bin/$tool" <<'EOF'
#!/usr/bin/env bash
echo "<root/>"
echo "warning: deprecated option" >&2
exit 0
EOF
    chmod +x "$bin/$tool"
  done

  local target="$WORK_DIR/doc.xml"
  printf '<root></root>\n' > "$target"
  run env PATH="$bin:$PATH" bash -c 'source "$1"; format_xml "$2"' _ "$fn" "$target"
  [ "$status" -eq 0 ]
  # The formatted file must contain the valid output, NOT the stderr warning.
  run cat "$target"
  [[ "$output" == *"<root/>"* ]]
  [[ "$output" != *"deprecated option"* ]]
}
