#!/usr/bin/env bash
# Tell the Shell Changed Files job whether it needs the Claude Code CLI.
#
# Usage: shell-changed-needs-claude.sh <base-ref>
#
# Asks scripts/prepush-shell.sh which fast validation checks the changes since
# <base-ref> select (--list-checks runs none of them) and writes
# `claude_plugin=true` to $GITHUB_OUTPUT when `claude-plugin` is one of them,
# `claude_plugin=false` otherwise. Only that check needs the CLI (#17010).
# The selector's own output is echoed to stdout for the job log.
#
# Exits 2 on a usage error and with the selector's status when it fails.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: shell-changed-needs-claude.sh <base-ref>" >&2
  exit 2
fi
if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
  echo "GITHUB_OUTPUT is not set." >&2
  exit 2
fi
base="$1"

set +e
checks="$("${PROJECT_ROOT}/scripts/prepush-shell.sh" --base "${base}" --list-checks)"
status=$?
set -e
if [[ "${status}" -ne 0 ]]; then
  echo "Failed to list the changed-file shell checks against ${base}." >&2
  exit "${status}"
fi

needs_claude=false
while IFS= read -r check; do
  [[ -n "${check}" ]] || continue
  echo "Selected check: ${check}"
  if [[ "${check}" == "claude-plugin" ]]; then
    needs_claude=true
  fi
done <<< "${checks}"

echo "claude_plugin=${needs_claude}" >> "${GITHUB_OUTPUT}"
echo "Claude Code CLI needed: ${needs_claude}"
