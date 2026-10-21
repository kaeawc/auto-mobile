#!/usr/bin/env bats
#
# Guards the pins on binaries CI downloads at runtime into jobs that hold
# secrets or write tokens: mcp-publisher (runs with MCP_DNS_PRIVATE_KEY) and the
# vouch comment job (installs the latest Nushell before its own role check).

RELEASE=".github/workflows/release.yml"
VOUCH_MANAGE=".github/workflows/vouch-manage-by-issue.yml"

install_mcp_publisher_step() {
  sed -n '/- name: Install mcp-publisher/,/- name: /p' "$RELEASE"
}

@test "mcp-publisher is downloaded from a pinned release, not releases/latest" {
  ! grep -q 'registry/releases/latest' "$RELEASE"
  install_mcp_publisher_step | grep -qE 'MCP_PUBLISHER_VERSION: v[0-9]+\.[0-9]+\.[0-9]+$'
}

@test "mcp-publisher's SHA-256 is checked before it is extracted" {
  step="$(install_mcp_publisher_step)"
  grep -qE 'MCP_PUBLISHER_SHA256: [0-9a-f]{64}$' <<<"$step"
  check_line="$(grep -n 'sha256sum -c' <<<"$step" | cut -d: -f1)"
  extract_line="$(grep -n 'tar xzf' <<<"$step" | cut -d: -f1)"
  [ -n "$check_line" ]
  [ "$check_line" -lt "$extract_line" ]
  # A pipe into tar would extract before any check could run.
  ! grep -q 'curl.*| *tar' <<<"$step"
}

@test "the MCP DNS key reaches the publish step through env, not the script body" {
  ! grep -q 'secrets.MCP_DNS_PRIVATE_KEY }}"' "$RELEASE"
  grep -q 'MCP_DNS_PRIVATE_KEY: ${{ secrets.MCP_DNS_PRIVATE_KEY }}' "$RELEASE"
}

@test "the vouch comment job only runs for repo collaborators" {
  grep -qF "contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association) &&" "$VOUCH_MANAGE"
}
