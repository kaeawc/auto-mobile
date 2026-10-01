# Contributing

Thanks for your interest in contributing to AutoMobile.

## Local Development

Run `scripts/local-dev/hot-reload.sh` to build all components and start a background
watcher that rebuilds and restarts on changes. `.mcp.json` is the shared Claude Code
project MCP configuration and should not be modified for local development. Claude
Code's private project MCP scope is managed by the Claude CLI; `.claude/settings*.json`
files configure Claude behavior and permissions, not MCP servers.

## SDK public API baselines

PR CI checks the Android and iOS SDK public APIs and fails when an API changes
without a baseline update. After reviewing an intentional API change, regenerate
the relevant baseline from the repository root:

```bash
# Android
cd android && ./gradlew :auto-mobile-sdk:apiDump
```

```bash
# iOS
scripts/ios/api-dump.sh > ios/auto-mobile-sdk/api/auto-mobile-sdk.api
```

Commit the updated baseline with the API change. The SDK checks also run in the
local pre-push gates (Android when the SDK module changes).
