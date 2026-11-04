# AutoMobile plugin for Claude Code

AutoMobile lets Claude Code drive Android devices and emulators and iOS simulators and devices:
observe the screen, tap, swipe and type, launch and manage apps, work the notification shade, and
record what it did. The plugin starts the AutoMobile MCP server and adds skills for common device
tasks.

## Install

In Claude Code, add this repository as a marketplace and install the plugin from it:

```text
/plugin marketplace add kaeawc/auto-mobile
/plugin install auto-mobile@auto-mobile-marketplace
```

From a terminal, the same two steps are:

```bash
claude plugin marketplace add kaeawc/auto-mobile
claude plugin install auto-mobile@auto-mobile-marketplace
```

The MCP server runs with `bunx @kaeawc/auto-mobile@latest`, so [Bun](https://bun.sh) must be on
your `PATH`. Android needs the Android SDK platform tools (`adb`); iOS needs Xcode on macOS. If a
tool call reports a missing SDK, device or daemon, run `/doctor`.

## What it adds

- **MCP server** `auto-mobile`: observation, interaction, app management and device management
  tools.
- **Skills**: `apps`, `doctor`, `explore`, `gesture`, `navigate`, `notifications`,
  `reproduce-bug`, `snapshot`, `system` and `text`.
- **Hook**: after an AutoMobile tool call that reports a setup problem, suggests `/doctor`.

## Learn more

- Documentation: <https://kaeawc.github.io/auto-mobile/>
- Source and issues: <https://github.com/kaeawc/auto-mobile>
- License: Apache-2.0
