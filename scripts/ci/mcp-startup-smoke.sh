#!/usr/bin/env bash
#
# Verifies the built MCP server starts under Bun and responds to initialize.

set -euo pipefail

export PATH="${HOME}/.bun/bin:${PATH}"

mkdir -p ci-logs

report_path="ci-logs/mcp-startup-smoke.json"

bash scripts/benchmark-startup.sh --server-only --output "$report_path"

jq -e '.passed == true and (.results.mcpServer.runs | length) > 0' "$report_path" >/dev/null
echo "MCP startup smoke passed: initialize response received"
