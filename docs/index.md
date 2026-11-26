# AutoMobile

**Hand your AI agent a phone.** AutoMobile is an MCP server that lets Claude, Cursor, Goose or any
MCP client see and drive Android and iOS devices: phones, tablets, foldables, watches, TVs, cars and
headsets, real or emulated. Ask for a bug repro, a UX walkthrough or a UI test in plain English,
and the agent taps through your app on a real device and shows you what it found. No root, no
jailbreak, no app changes: it rides on `adb`, `simctl` and open-source Kotlin and Swift companions.

![Setting an alarm in the Clock app](img/clock-app.gif)

## Compared with driving the device yourself

An agent with a shell can already run `adb` and `simctl`. Here is what AutoMobile adds:

|                               | AutoMobile                                                                                                                                | An agent with `adb` and `simctl`                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Seeing the screen             | view hierarchy and screenshot from an on-device Accessibility Service and XCTestService, settled after every action                       | `uiautomator dump` and `screencap` by hand; on iOS, a screenshot and no hierarchy without a test runner |
| Targeting                     | tap, swipe, pinch, drag and type on elements by text or id                                                                                | raw coordinates guessed from a screenshot                                                               |
| iOS simulator input           | **0.5 ms** per tap, **1 ms** per Home press, no runner needed                                                                             | 438 ms per tap and 482 ms per Home press through an XCTest runner                                       |
| Getting around an app         | learns its screens and jumps to one by name ([navigation graph](using/navigation-graph.md))                                               | taps its way there every time                                                                           |
| Sharing devices               | [sessions own devices](using/device-ownership.md), so parallel agents never collide                                                       | whoever runs `adb` last wins                                                                            |
| iOS network conditions        | [per simulator](using/ios-network-condition.md), no root, no profile, works on headless CI Macs                                           | Network Link Conditioner for the whole Mac                                                              |
| Traces and audits             | [Perfetto and Instruments traces](using/performance-trace.md), [accessibility and performance audits](using/audits.md), visual regression | assemble each tool yourself                                                                             |
| Turning a session into a test | [YAML plans](using/ui-tests.md) run natively by a Kotlin JUnitRunner and a Swift XCTestRunner                                             | write it from scratch                                                                                   |

The input times were measured on one iOS simulator under the same load, 2026-11-23
([devlog](devlog/2026-11-23-simulator-hid-input-default-on.md)).

**129 tools** cover Android (113), iOS (94), tvOS (21), watchOS (18) and visionOS (15). Every one
runs from MCP, the CLI and the daemon's HTTP endpoint, with the same names and arguments
([tools](tools.md)).

## Install

<div class="content-tabs" markdown>

### One-line install

<div class="install-command" markdown>

```bash
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/install.sh | bash
```

</div>

Run this in your app repository for project configuration, or elsewhere for
global configuration. Restart your MCP client when it finishes.

![Install Demo](img/install.gif)

<div class="desktop-install-options">
  <a data-platform="macos" href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.96/AutoMobile-0.0.96-macos.dmg" aria-label="Download AutoMobile Desktop App for macOS x86-64">
    <strong>macOS</strong>
    <span>x86_64 · DMG</span>
  </a>
  <a data-platform="linux" href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.96/AutoMobile-0.0.96-linux.deb" aria-label="Download AutoMobile Desktop App for Linux x86-64">
    <strong>Linux</strong>
    <span>x86_64 · DEB</span>
  </a>
  <a data-platform="windows" href="https://github.com/kaeawc/auto-mobile/releases/download/0.0.96/AutoMobile-0.0.96-windows.msi" aria-label="Download AutoMobile Desktop App for Windows x86-64">
    <strong>Windows</strong>
    <span>x86_64 · MSI</span>
  </a>
</div>

### Homebrew (CLI)

```bash
brew tap kaeawc/tap
brew install kaeawc/tap/auto-mobile
```

Installs the `auto-mobile` command-line tool and keeps it current through
`brew upgrade`. On recent Homebrew, run `brew trust kaeawc/tap` first if the
tap is reported untrusted.

### Manual MCP configuration

```json
{
  "command": "bunx",
  "args": ["@kaeawc/auto-mobile@latest"]
}
```

Place this server in the client’s documented MCP configuration, then restart
the client. Going this route means you're going to handle dependencies like having
bun and ffmpeg.

</div>

## First use

Open your configured agent and ask it to explore your mobile app. If you have a connected physical device it'll recognize it, otherwise it'll look for emulators / simulators to use or provision.

Some common workflows:

- [Agent examples](using/agent-examples.md)
- [Hackathon demo kit](using/hackathon.md)

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/main/scripts/uninstall.sh | bash
```
