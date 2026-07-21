# Contributing

Thanks for your interest in contributing to AutoMobile.

## Local Development

Run `scripts/local-dev/hot-reload.sh` to build all components and start a background
watcher that rebuilds and restarts on changes. `.mcp.json` is the shared Claude Code
project MCP configuration and should not be modified for local development. Claude
Code's private project MCP scope is managed by the Claude CLI; `.claude/settings*.json`
files configure Claude behavior and permissions, not MCP servers.
