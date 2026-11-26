# AutoMobile

[![Pull Request](https://github.com/kaeawc/auto-mobile/actions/workflows/pull_request.yml/badge.svg)](https://github.com/kaeawc/auto-mobile/actions/workflows/pull_request.yml)
[![On Merge](https://github.com/kaeawc/auto-mobile/actions/workflows/merge.yml/badge.svg)](https://github.com/kaeawc/auto-mobile/actions/workflows/merge.yml)
[![Nightly](https://github.com/kaeawc/auto-mobile/actions/workflows/nightly.yml/badge.svg)](https://github.com/kaeawc/auto-mobile/actions/workflows/nightly.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![Platform: Linux](https://img.shields.io/badge/platform-Linux-lightgrey)

![TypeScript tests](https://img.shields.io/endpoint?url=https://kaeawc.github.io/auto-mobile/typescript-tests-badge.json)
![Kotlin tests](https://img.shields.io/endpoint?url=https://kaeawc.github.io/auto-mobile/kotlin-tests-badge.json)
![Swift tests](https://img.shields.io/endpoint?url=https://kaeawc.github.io/auto-mobile/swift-tests-badge.json)
![Kotlin coverage](https://img.shields.io/endpoint?url=https://kaeawc.github.io/auto-mobile/kotlin-coverage-badge.json)
![Swift coverage](https://img.shields.io/endpoint?url=https://kaeawc.github.io/auto-mobile/swift-coverage-badge.json)

![AutoMobile sticker](docs/img/auto_mobile_sticker_splash.png)

**Hand your AI agent a phone.** AutoMobile is an MCP server that lets Claude, Cursor, Goose or any
MCP client see and drive Android and iOS devices: phones, tablets, foldables, watches, TVs, cars and
headsets, real or emulated. Ask for a bug repro, a UX walkthrough or a UI test in plain English,
and the agent taps through your app on a real device and shows you what it found. No root, no
jailbreak, no app changes: it rides on `adb`, `simctl` and open-source Kotlin and Swift companions.

![Setting an alarm in the Clock app](docs/img/clock-app.gif)
_An AI agent navigating to the Clock app, creating a new alarm_

![Searching YouTube for a video](docs/img/youtube-search.gif)
_An AI agent searching YouTube and browsing results_

## Compared with driving the device yourself

An agent with a shell can already run `adb` and `simctl`. Here is what AutoMobile adds:

|                               | AutoMobile                                                                                                          | An agent with `adb` and `simctl`                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Seeing the screen             | view hierarchy and screenshot from an on-device Accessibility Service and XCTestService, settled after every action | `uiautomator dump` and `screencap` by hand; on iOS, a screenshot and no hierarchy without a test runner |
| Targeting                     | tap, swipe, pinch, drag and type on elements by text or id                                                          | raw coordinates guessed from a screenshot                                                               |
| iOS simulator input           | **0.5 ms** per tap, **1 ms** per Home press, no runner needed                                                       | 438 ms per tap and 482 ms per Home press through an XCTest runner                                       |
| Getting around an app         | learns its screens and jumps to one by name (`explore`, `navigateTo`)                                               | taps its way there every time                                                                           |
| Sharing devices               | sessions own devices, so parallel agents never collide                                                              | whoever runs `adb` last wins                                                                            |
| iOS network conditions        | per simulator, no root, no profile, works on headless CI Macs                                                       | Network Link Conditioner for the whole Mac                                                              |
| Traces and audits             | Perfetto and Instruments traces, accessibility and performance audits, visual regression                            | assemble each tool yourself                                                                             |
| Turning a session into a test | YAML plans run natively by a Kotlin JUnitRunner and a Swift XCTestRunner                                            | write it from scratch                                                                                   |

The input times were measured on one iOS simulator under the same load, 2026-11-23
([devlog](docs/devlog/2026-11-23-simulator-hid-input-default-on.md)).

**129 tools** cover Android (113), iOS (94), tvOS (21), watchOS (18) and visionOS (15). Every one
runs from MCP, the CLI and the daemon's HTTP endpoint, with the same names and arguments
([tools](docs/tools.md)).

### What you can ask for

| Task                                                         | What it does                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **[Explore app UX](docs/using/agent-examples.md)**           | Navigate your app, discover screens, map user flows, identify confusing interactions |
| **[Reproduce bugs](docs/using/agent-examples.md)**           | Paste a bug report and get exact reproduction steps with screenshots                 |
| **[Create UI tests](docs/using/ui-tests.md)**                | Describe test scenarios in plain English, get executable test plans                  |
| **[Measure startup time](docs/using/agent-examples.md)**     | Profile cold and warm launch performance                                             |
| **[Check scroll performance](docs/using/agent-examples.md)** | Detect jank and dropped frames                                                       |

## Get Started

The interactive installer checks host dependencies, optionally downloads the Android or iOS
developer tools, and configures the MCP daemon:

```bash title="One-line install (click to copy)"
curl -fsSL https://raw.githubusercontent.com/kaeawc/auto-mobile/refs/heads/main/scripts/install.sh | bash
```

Prefer Homebrew for the CLI:

```bash title="Homebrew (click to copy)"
brew install kaeawc/tap/auto-mobile
```

Using Claude Code? Install the plugin from this repository's marketplace:

```text title="Claude Code plugin (click to copy)"
/plugin marketplace add kaeawc/auto-mobile
/plugin install auto-mobile@auto-mobile-marketplace
```

Then ask your agent to explore your app. It uses a connected device if there is one, and otherwise
finds or provisions an emulator or simulator. Other routes: the [installation guide](docs/index.md#install).

## What it covers

Android phones, tablets, foldables, Android TV, Wear OS, Android Automotive, Android Auto and
Android XR; iPhone, iPad, Apple TV, Apple Watch, CarPlay and visionOS. Physical devices and
emulators or simulators alike. Android works from macOS or Linux; Apple platforms need macOS with Xcode.

## Not yet

- Some capabilities work only on emulators and simulators, such as vehicle property injection on
  Automotive; physical head units answer `unsupported`.
- CarPlay needs an iOS 26 simulator, and its input effects are not confirmed yet.
- Fast iOS simulator input does not handle rotated screens yet; landscape input goes through the
  XCTest runner.
- `heapDump` is not available on physical iPhones.
- The navigation graph tools (`explore`, `navigateTo`) are off by default.

## Documentation

|                                                |                                                |
| ---------------------------------------------- | ---------------------------------------------- |
| [Full documentation](docs/index.md)            | install, first use, every platform             |
| [Tools](docs/tools.md)                         | all 129 tools, with platforms and requirements |
| [Agent examples](docs/using/agent-examples.md) | prompts that work, and what they produce       |
| [UI tests](docs/using/ui-tests.md)             | YAML plans run by JUnitRunner and XCTestRunner |
| [How it works](docs/how-it-works/index.md)     | architecture and implementation details        |
| [FAQ](docs/faq.md)                             | common questions answered                      |
| [Devlog](docs/devlog/index.md)                 | dated decision records and measurements        |

## Contributing

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md) - report vulnerabilities privately via GitHub
- [Contributing](.github/CONTRIBUTING.md)
