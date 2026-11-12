# 🧰 Tools

Every tool works from the **CLI** (`bunx @kaeawc/auto-mobile --cli <tool>`), **MCP**, or the **daemon** HTTP endpoint — same names, same arguments.

📖 Full arguments: the registered schema ([`schemas/tool-definitions.json`](https://github.com/kaeawc/auto-mobile/blob/main/schemas/tool-definitions.json)) or `automobile:tools`. Availability varies by platform and feature gates: see the **Requires** column.

## 🔐 Requires column

Each tool's `_meta["automobile/requires"]` list, shown in the tables below:

- `sdkEmbed` — start the daemon with `--embedded-sdk`.
- `debugBuild` — start the daemon with `--debug` (the `debug` feature flag).
- `featureFlag:<key>` — some or all calls are refused while that feature flag is off; enable it with `auto-mobile --daemon set-feature-flag <key> true`.
- Platforms — a device tool drives Android and iOS unless the cell lists other platforms (watchOS, tvOS, visionOS). A tool may still answer `unsupported` for an action its description limits to one platform.
- A `—` cell: nothing beyond a device, or no device at all.

## 🏷️ Tool discovery metadata

- 📋 `tools/list` entries carry a human-readable `title` and SDK `ToolAnnotations`.
- 🛡️ Hints are untrusted client guidance, never authorization.
- 🗂️ Classification lives in `src/server/toolAnnotations.ts`.
- 🔀 Mixed-action tools take the conservative union of all supported actions.
- 📦 The wire omits default `readOnlyHint: false`, `idempotentHint: false`, and `openWorldHint: true`.
- 📖 Read-only tools omit the meaningless destructive and idempotent hints.
- 🎛️ Controls always declare `destructiveHint` explicitly.
- 🔑 Metadata is independent of `deviceReadOnly` dispatch and ownership enforcement.
- 🧪 `readOnlyHint` follows `deviceReadOnly`, except tools that also write host state (`compareScreenshot` record mode).

## 🔁 Shared options

- 🔑 `sessionUuid` — run on a held device session (device tools)
- 💡 `keepScreenAwake` — wake and keep a physical Android device awake (default on at session setup)
- 🪞 `raw` / `project` (`skeleton` default, `full`) / `includeExtras` — observation output on action tools
- 🔗 `resourceLink` — `getLogs`, `exportPlan`, and `videoRecording` stop: return the complete result as an `automobile:tool-output` resource and a `resource_link` block, keeping only `success`, `error`, and the result's required fields (a stop's `action`, `count`, `recordings`, each bounded) inline (default off, inline)
- 📱 `deviceId` — target a device explicitly on reads

### Reading a device you do not own (`deviceId`)

A read never writes settings on a device another session holds. A sessionless read of an unheld running device may ready it (install CtrlProxy / runner) to answer. See [which read tools ready an unheld device](using/device-ownership.md#which-read-tools-ready-an-unheld-device).

## 👀 Observe & navigate

| Tool                                 | What it does                                                                                                                                                        | Requires                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 📸 <code>snapshotOf</code>           | Save a PNG crop of one exposed element or a platform-native screen rectangle                                                                                        | —                                          |
| 🆚 <code>compareScreenshot</code>    | Visual regression: record a named screenshot baseline or compare the current screen, an element, or a rectangle against it, ignoring masked regions and system bars | Android, iOS, tvOS                         |
| 👁️ <code>observe</code>              | Get screen view hierarchy and screenshot, with optional PNG crop from a fresh settled capture of one display                                                        | Android, iOS, watchOS, tvOS, visionOS      |
| 🎯 <code>hitTest</code>              | Preview hierarchy-bounds candidates at a platform-native screen point                                                                                               | —                                          |
| 🧭 <code>explore</code>              | Automatically interact with the app to discover screens and record transitions in the navigation graph                                                              | <code>sdkEmbed</code> · Android, iOS, tvOS |
| 🗺️ <code>navigateTo</code>           | Navigate to a learned screen by replaying recorded transitions from the navigation graph                                                                            | <code>sdkEmbed</code>                      |
| 🕸️ <code>getNavigationGraph</code>   | Get the learned navigation graph for the foreground or given app                                                                                                    | <code>sdkEmbed</code>                      |
| 🔎 <code>identifyInteractions</code> | Suggest likely interactions                                                                                                                                         | <code>debugBuild</code>                    |
| 🧪 <code>prototype</code>            | Show agent-authored UI on the device                                                                                                                                | —                                          |
| 🌐 <code>exportPrototypeWeb</code>   | Write the `automobile:prototype/<id>/web` page to an HTML file                                                                                                      | —                                          |
| 📡 <code>blePeripheral</code>        | Manage a session-owned virtual BLE peripheral on Android netsim                                                                                                     | —                                          |
| 🔦 <code>highlight</code>            | Draw a red hand-drawn circle around a UI element                                                                                                                    | —                                          |

## 👆 Interact

| Tool                                         | What it does                                                                                                      | Requires                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 📍 [<code>tapAt</code>](using/tap-at.md)     | Tap, long press, or double tap at screen coordinates in native, normalized, or percent units                      | Android, iOS, watchOS                 |
| 👆 <code>tapOn</code>                        | Tap an element by text/content-desc, resource-id, or Android test tag                                             | Android, iOS, watchOS, tvOS, visionOS |
| 🤏 <code>tapAny</code>                       | Tap any clickable element                                                                                         | —                                     |
| 👉 [<code>swipeOn</code>](using/swipe-on.md) | Swipe/scroll on screen or elements                                                                                | Android, iOS, watchOS                 |
| ↔️ <code>swipeAt</code>                      | Swipe from one screen point to another, including diagonals, in native, normalized, or percent units              | —                                     |
| 🫳 <code>dragAndDrop</code>                  | Drag and drop element                                                                                             | —                                     |
| 〰️ <code>dragPath</code>                     | Drag a finger along a polyline with segment timing, an initial hold and a release hold                            | —                                     |
| 🖱️ <code>hoverAt</code>                      | Hover a stylus or mouse over a path with no contact                                                               | —                                     |
| 🤌 <code>pinchOn</code>                      | Pinch to zoom                                                                                                     | —                                     |
| 🖐️ <code>multiTouch</code>                   | Simultaneous 2-5 finger tap, long press, or swipe at a screen point                                               | —                                     |
| ⌨️ <code>sendKeys</code>                     | Execute ordered typing, clear, raw-key, and semantic IME commands                                                 | Android, iOS, watchOS, tvOS, visionOS |
| 🧭 <code>focusNavigate</code>                | Move D-pad focus to an element on a focus-driven UI such as Android TV or Apple TV                                | Android, iOS, tvOS                    |
| 🎛️ <code>setUIState</code>                   | Set multiple form fields by desired state                                                                         | <code>debugBuild</code>               |
| 📝 <code>selectAllText</code>                | Select all text in focused input                                                                                  | —                                     |
| 🔘 <code>pressButton</code>                  | Press a device or navigation button                                                                               | Android, iOS, watchOS, tvOS           |
| ⌨️ <code>keyboard</code>                     | Open, close, detect, list/select installed Android IMEs, or switch the AutoMobile typing profile                  | —                                     |
| 📋 <code>clipboard</code>                    | Clipboard operations                                                                                              | —                                     |
| 🗣️ <code>siri</code>                         | iOS: activate Siri with a spoken phrase, e.g. to invoke an App Shortcut / App Intent, then return the observation | —                                     |

## 📦 Apps, files & data

| Tool                                                | What it does                                                                                                                  | Requires                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 🗂️ <code>listApps</code>                            | List installed apps on a device, with optional display label and launchable fields when reported by the platform or transport | Android, iOS, watchOS, tvOS, visionOS |
| 🚀 <code>launchApp</code>                           | Launch app by package name                                                                                                    | Android, iOS, watchOS, tvOS, visionOS |
| 🛑 <code>terminateApp</code>                        | Terminate app by package name                                                                                                 | Android, iOS, watchOS, tvOS, visionOS |
| 💥 <code>crashApp</code>                            | Intentionally crash a running app through the platform crash path                                                             | Android, iOS, watchOS, tvOS           |
| 🔄 <code>appLifecycle</code>                        | State-preserving background-process kill for saved-state restoration tests                                                    | —                                     |
| ⬇️ <code>installApp</code>                          | Install app on device                                                                                                         | Android, iOS, watchOS, tvOS, visionOS |
| 🗑️ <code>uninstallApp</code>                        | Uninstall app by package name or bundle identifier                                                                            | Android, iOS, watchOS, tvOS, visionOS |
| 🔏 <code>inspectPackageSigning</code>               | Fresh read of one app's presence and signing                                                                                  | —                                     |
| 🔗 <code>getDeepLinks</code>                        | Query app deep links                                                                                                          | Android, iOS, tvOS                    |
| 📥 <code>putAppFile</code>                          | Write files into a bounded logical storage target                                                                             | —                                     |
| 🧹 <code>resetAppLogs</code>                        | Reset explicitly named app-container log files on the session's device, reporting a per-path outcome                          | —                                     |
| ⚙️ <code>getPreference</code>                       | Read an Android system property, Android SharedPreferences key, or iOS UserDefaults key                                       | —                                     |
| ⚙️ <code>setPreference</code>                       | Write an Android system property, Android SharedPreferences key, or iOS UserDefaults key and return read-back verification    | —                                     |
| 🗝️ <code>deleteKeychainItem</code>                  | Delete one exact, host-allowlisted, app-owned iOS generic-password Keychain item                                              | <code>sdkEmbed</code>                 |
| 🔑 <code>setKeyValue</code>                         | Set app key-value storage entry                                                                                               | <code>sdkEmbed</code>                 |
| ❌ <code>removeKeyValue</code>                      | Remove app key-value storage entry                                                                                            | <code>sdkEmbed</code>                 |
| 🧼 <code>clearKeyValueFile</code>                   | Clear app key-value storage file                                                                                              | <code>sdkEmbed</code>                 |
| 🗄️ <code>listDataStores</code>                      | List app Jetpack DataStore instances                                                                                          | <code>sdkEmbed</code>                 |
| 🗄️ <code>getDataStore</code>                        | Read entries from an app Jetpack DataStore instance                                                                           | <code>sdkEmbed</code>                 |
| 🧮 <code>sqlQuery</code>                            | Execute SQL on an app SQLite database, or read a registered Core Data entity on iOS using store and entity                    | <code>sdkEmbed</code>                 |
| 🔐 <code>resetKeychain</code>                       | Reset secure test state                                                                                                       | —                                     |
| 🔗 <code>setAppLinks</code>                         | Android 12+: change an app's App Links state so https links open the app directly                                             | —                                     |
| 🚦 [<code>performanceAudit</code>](using/audits.md) | Pass/fail performance checks of an app on the current screen, against the configured thresholds                               | —                                     |
| ⏱️ <code>measureStartup</code>                      | Android: measure cold/warm/hot app startup over N launches                                                                    | —                                     |
| 📜 <code>getLogs</code>                             | Read device logs with filters                                                                                                 | Android, iOS, watchOS, tvOS, visionOS |
| 📡 <code>sendBroadcast</code>                       | Android: send an explicit broadcast to the app under test with a typed intent, e.g. to toggle a debug flag or seed data       | —                                     |
| 🛠️ <code>backgroundWork</code>                      | Android: read and trigger an app's background work without waiting hours                                                      | —                                     |

## 📱 Devices & system

| Tool                                                 | What it does                                                                                                                                                                                                                                                               | Requires                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 📃 <code>listDevices</code>                          | List booted devices                                                                                                                                                                                                                                                        | —                                         |
| 💿 <code>listDeviceImages</code>                     | List device images                                                                                                                                                                                                                                                         | —                                         |
| 🤖 <code>getAndroid</code>                           | Find or recover an Android AVD and prepare it for automation                                                                                                                                                                                                               | —                                         |
| 🍎 <code>getApple</code>                             | Find or recover an iOS Simulator and prepare it for automation                                                                                                                                                                                                             | —                                         |
| 🏗️ <code>provisionDevice</code>                      | Provision exact virtual device                                                                                                                                                                                                                                             | —                                         |
| 🧰 <code>setDeviceResources</code>                   | Set selected device resources and verify native state, including disabled iOS service impacts                                                                                                                                                                              | —                                         |
| ⚖️ <code>reconcileDeviceResources</code>             | Compare an iOS Simulator with a requested resource map and report typed drift                                                                                                                                                                                              | —                                         |
| ✅ <code>setActiveDevice</code>                      | Set active device using existing session binding or a sessionless per-MCP-connection device pin that lasts for that connection                                                                                                                                             | —                                         |
| 🔌 <code>killDevice</code>                           | Kill device                                                                                                                                                                                                                                                                | —                                         |
| 🗑️ <code>deleteDevice</code>                         | Stop and permanently delete a device, with verified platform-inventory absence                                                                                                                                                                                             | —                                         |
| 💾 <code>deviceSnapshot</code>                       | Capture, restore or delete a device snapshot                                                                                                                                                                                                                               | —                                         |
| 🔃 <code>rotate</code>                               | Rotate device orientation                                                                                                                                                                                                                                                  | —                                         |
| 🔁 <code>portReverse</code>                          | Android: manage adb reverse mappings so the app or browser on the device reaches a host server at `localhost:<port>`                                                                                                                                                       | —                                         |
| 📐 <code>setPosture</code>                           | Set Android device posture or iPhone Duo simulator posture, with an optional Resizable Android display preset                                                                                                                                                              | —                                         |
| 📶 <code>statusBar</code>                            | Deterministic status bar for screenshots and video                                                                                                                                                                                                                         | —                                         |
| 🪟 <code>windowMode</code>                           | Android: put an app's task into fullscreen, picture-in-picture, freeform or split screen with a second app, and read the mode and bounds back                                                                                                                              | —                                         |
| 🎛️ <code>rotaryScroll</code>                         | Wear OS: scroll with the rotary crown                                                                                                                                                                                                                                      | —                                         |
| 🥽 <code>glassesInput</code>                         | Android XR glasses touchpad tap and forward/back swipe as focus input                                                                                                                                                                                                      | —                                         |
| 🌙 <code>ambient</code>                              | Wear OS watches only: enter sends KEYCODE_SLEEP, exit sends KEYCODE_WAKEUP, then reads wakefulness and the watch face's inAmbient from dumpsys wear_service, reported as ambient                                                                                           | —                                         |
| 🧩 <code>wearSurface</code>                          | Wear OS watches only: tiles, watch faces and complications                                                                                                                                                                                                                 | —                                         |
| ⌚ <code>rotateCrown</code>                          | watchOS only: rotate the Apple Watch Digital Crown by a signed, non-zero delta in full revolutions, with optional positive velocity                                                                                                                                        | watchOS                                   |
| 🌍 <code>openLink</code>                             | Open URL in browser                                                                                                                                                                                                                                                        | Android, iOS, tvOS                        |
| 🏠 <code>homeScreen</code>                           | Go to home screen                                                                                                                                                                                                                                                          | Android, iOS, tvOS                        |
| 🕘 <code>recentApps</code>                           | Open recent apps                                                                                                                                                                                                                                                           | —                                         |
| 🔔 <code>systemTray</code>                           | System tray actions for notifications                                                                                                                                                                                                                                      | —                                         |
| 🔓 <code>wakeAndUnlock</code>                        | Wake a device and unlock its keyguard                                                                                                                                                                                                                                      | —                                         |
| 🌍 <code>changeLocalization</code>                   | Change locale, time zone, text direction, time format, and calendar system                                                                                                                                                                                                 | —                                         |
| 🩺 <code>getDeviceState</code>                       | Read device-level state including clock, Do Not Disturb, the connectivity toggles, iOS Simulator biometric enrollment, network condition, and Android emulator virtual sensor values                                                                                       | —                                         |
| 🔧 <code>setDeviceState</code>                       | Set device state such as Do Not Disturb, Android connectivity toggles, static location or background route playback on an Android emulator, iOS Simulator, or physical iOS device, iOS Simulator biometric enrollment, and device-wide network condition                   | <code>featureFlag:device-condition</code> |
| 🖥️ <code>displayConfig</code>                        | Read or set the visual display configuration — font/text scale, effective display density, light/dark theme, and on Android the runtime screen size, navigation mode and display-cutout emulation — for adaptive-layout, edge-to-edge and large-font accessibility testing | —                                         |
| 🎨 <code>displayProfile</code>                       | Android: apply an OEM-style display profile in one call, composing `displayConfig` and `setPosture`                                                                                                                                                                        | —                                         |
| 🍏 <code>getIosSimulatorCapabilities</code>          | Discover biometric capabilities for a selected iOS Simulator device type and runtime                                                                                                                                                                                       | —                                         |
| 🪪 <code>biometricAuth</code>                        | Simulate biometric auth: Android emulator/SDK hook, or iOS via the app's AutoMobile SDK or Simulator                                                                                                                                                                       | —                                         |
| 📳 <code>shake</code>                                | Shake device; iOS Simulator and Android emulator only                                                                                                                                                                                                                      | —                                         |
| 🧲 <code>setSensor</code>                            | Set or reset one Android emulator virtual sensor through the emulator console                                                                                                                                                                                              | —                                         |
| 🎙️ <code>injectAudioInput</code>                     | Play a WAV file or a built-in tone into an Android emulator's or iOS Simulator's microphone, so an app under test records known audio                                                                                                                                      | —                                         |
| ⏹️ <code>stopAudioInput</code>                       | Stop an audio injection started by `injectAudioInput`, on the device it runs on                                                                                                                                                                                            | —                                         |
| 🔊 <code>captureAudio</code>                         | Record up to 20 s of an Android emulator's or iOS Simulator's audio output and report its level                                                                                                                                                                            | —                                         |
| 📞 <code>phoneCall</code>                            | Simulate a phone call: Android emulator gsm commands, or CallKit via the app's AutoMobile iOS SDK                                                                                                                                                                          | —                                         |
| 💬 <code>sendSms</code>                              | Send simulated incoming SMS: Android emulator, or a notification via the app's AutoMobile iOS SDK                                                                                                                                                                          | —                                         |
| 🌱 [<code>seedContent</code>](using/seed-content.md) | Seed Android contacts, calendar events, call history and SMS inbox, tagged `automobile.<namespace>`                                                                                                                                                                        | —                                         |
| 🎵 <code>mediaSession</code>                         | Android media sessions: read playback state, position, speed, metadata and actions                                                                                                                                                                                         | —                                         |
| 📣 <code>postNotification</code>                     | Post notification via Android SDK hooks or iOS/watchOS/tvOS simulator simctl push                                                                                                                                                                                          | Android, iOS, watchOS, tvOS               |
| 🔕 <code>getNotificationPolicy</code>                | Read app notification/DND policy state                                                                                                                                                                                                                                     | —                                         |
| 🔕 <code>setNotificationPolicy</code>                | Set app notification/DND policy state                                                                                                                                                                                                                                      | —                                         |
| 🛂 <code>getAppPermissions</code>                    | Read app permission state                                                                                                                                                                                                                                                  | —                                         |
| 🛂 <code>setAppPermissions</code>                    | Grant or revoke app permissions                                                                                                                                                                                                                                            | Android, iOS, tvOS                        |
| ☠️ <code>killProfile</code>                          | Android: simulate an OEM background-kill policy on a stock device with standby buckets, appops, Doze, permission revocation, foreground-change kills, timed screen-off cleanup, boot-receiver observations and force-stop                                                  | —                                         |
| 🏭 <code>manufacturerProfile</code>                  | Android: apply an OEM manufacturer profile on a stock device by composing the keyboard profile, `killProfile` and `displayProfile` executors                                                                                                                               | —                                         |
| ⚠️ <code>systemAlerts</code>                         | Set how OS permission and system alerts are handled before and after each UI interaction on this device, including `executePlan` steps                                                                                                                                     | —                                         |

## 🌐 Network, plans & recording

| Tool                                 | What it does                                                                                 | Requires                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 📶 <code>network</code>              | Control network capture and error simulation                                                 | <code>sdkEmbed</code>                        |
| 🎭 <code>mockNetwork</code>          | Add mock network response rule                                                               | <code>sdkEmbed</code>                        |
| 🧽 <code>clearMockNetwork</code>     | Clear mock network response rules                                                            | <code>sdkEmbed</code>                        |
| 🕸️ <code>getNetworkGraph</code>      | Get aggregate captured network graph                                                         | <code>sdkEmbed</code>                        |
| ▶️ <code>executePlan</code>          | Execute YAML plan steps                                                                      | Android, iOS, watchOS, tvOS, visionOS        |
| 🔒 <code>criticalSection</code>      | Synchronize multiple devices at a barrier, then run steps serially                           | —                                            |
| 🚧 <code>barrier</code>              | Synchronize multiple devices at a barrier, then let all proceed concurrently                 | —                                            |
| ⏺️ <code>recordToolCalls</code>      | Record MCP tool calls to a YAML plan                                                         | <code>featureFlag:tool-call-recording</code> |
| 🎬 <code>recordDeviceGestures</code> | Start recording on-device user input for `exportPlan`                                        | —                                            |
| 📤 <code>exportPlan</code>           | Stop the active `recordDeviceGestures` or `recordToolCalls` recording and export a YAML plan | —                                            |
| 🎥 <code>videoRecording</code>       | Start or stop device video recording                                                         | Android, iOS, tvOS                           |
| 📈 <code>performanceTrace</code>     | Record a native performance trace                                                            | —                                            |
| 🔬 <code>captureTrace</code>         | Android: record a Perfetto trace from typed categories                                       | —                                            |
| 🧠 <code>heapDump</code>             | Android: dump a running debuggable or profileable app's heap to a host.hprof                 | —                                            |

## ♿ Accessibility & tooling

| Tool                                                  | What it does                                                                                             | Requires                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------- |
| 🦮 <code>accessibility</code>                         | Check or control accessibility services                                                                  | —                       |
| 🎯 <code>accessibilityFocus</code>                    | Set accessibility focus on Android and iOS by resourceId, text, or contentDesc                           | <code>debugBuild</code> |
| 🫶 <code>accessibilityAction</code>                   | Perform an Android accessibility action on an element, the way TalkBack or Switch Access does            | —                       |
| ✅ [<code>accessibilityAudit</code>](using/audits.md) | Audit the accessibility of the current screen                                                            | —                       |
| 🧾 <code>audit</code>                                 | Deprecated: use `accessibilityAudit` for accessibility and `performanceAudit` for performance and memory | —                       |
| 🧩 <code>setToolEnabled</code>                        | Control tools/list discovery for this MCP session                                                        | —                       |

## 📺 TV focus navigation

`focusNavigate({ until, direction?, maxSteps?, settleMs?, select? })` (#14947) drives focus-based UIs on Android TV and
Apple TV. It observes, and while the input-focused element (`focusedElement`) does not match `until` (`text`,
`contentDesc`, `resourceId`, or a lone `label`/`elementId` resolved to the element `tapOn` would tap) it presses the
D-pad arrow toward the nearest match, or `direction` when given, then observes again. With no focused element or no
match on screen it presses down. When a press leaves focus unchanged, or keeps moving focus without getting closer,
the other arrows are tried. It returns the `path` of focused elements and a `status`: `focused`, `max_steps`
(default 30, at most 100) or `stuck` (every arrow from the focused element was tried; an explicit `direction` stops
after two unchanged presses). With `select: true` it presses enter once focused and reports `selected`. On Apple TV
the arrows are Siri Remote directional presses, `select` presses the remote's select button, and focus is re-read
after each press (see `docs/how-it-works/plat/android/form-factors.md` and
`docs/how-it-works/plat/tvos/xcuitest-spike.md`).

## 📝 Notes

- ⌨️ Compact observations fold soft-keyboard keys into one `keyboard: { visible: true, package: "…" }` summary plus at most one skeleton row (`<ime> | Keyboard (…) | input`). The row appears only with at least one bounded accessible descendant.
- 📸 Screenshot paths are kept for **at least 10 minutes after return** unless evicted early under capacity pressure; each path has a `screenshotExpiresAt`/`expiresAt` (host epoch ms, not a promise). Retention starts at **128 MiB** and scales by 64 MiB per active device up to 1 GiB, within a limit of **4096 files**. Each device’s newest 3 screenshots (counting its incoming frame) are evicted only as a last resort, and a capture is admitted even if nothing fits. The byte limits and per-device allowance are [configurable](using/environment-variables.md#screenshot-retention). After a restart, existing files get a process-start grace of ten minutes.
- 🧹 `holdSessionOnFailure` keeps plan sessions instead of auto-releasing them.

### No audio input (`audio_input_unavailable`)

When a device cannot record audio, `observe` returns `diagnostics: [{ code: "audio_input_unavailable", message, retryable: false }]`,
and a `setAppPermissions` grant of `microphone` (iOS) or `RECORD_AUDIO` (Android) still succeeds but carries the same
`diagnostics` entry. This applies to an iOS simulator on a host with no audio input device, and to an Android emulator launched
with `-no-audio` (`AUTOMOBILE_EMULATOR_AUDIO=false`) or with `hw.audioInput=no`. Recordings on that device contain no audio.
Treat this as an environment limitation: do not retry, and do not report it as an app failure. Fix the host (for example, make a
virtual loopback device the default input) or the AVD audio settings. The `message` names the cause.

### Stylus pointer on `tapAt`, `swipeAt` and `dragPath`

`pointer: { toolType: "stylus" }` injects a stylus instead of a finger (Android only; never falls back to a finger).

| `pointer` shape                                                                                                      | Route                     | Needs                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------- |
| `{ toolType: "stylus" }`, `pressure` omitted or `1` (`tapAt`, `swipeAt`)                                             | `adb shell input stylus`  | Android 12+ (API 31)            |
| `pressure` other than 1, `tilt` (radians, 0 to PI/2), `orientation` (radians), or `buttons` (`primary`, `secondary`) | CtrlProxy instrumentation | `stylus_input_v1` (Android 12+) |
| `dragPath` with any `pointer`                                                                                        | CtrlProxy instrumentation | `stylus_input_v1` (Android 12+) |

On an emulator or userdebug build whose `adb shell` already runs as root (after `adb root`) and has the `uinput` tool, a stylus
stroke with `pressure`, `tilt`, `orientation`, `buttons` and a `dragPath` also works without `stylus_input_v1`, through a
virtual pen; each stroke starts about 4 seconds later while the pen attaches.

`pointer: { toolType: "eraser" }` touches with the pen's eraser end (apps see `TOOL_TYPE_ERASER`) on `tapAt`, `swipeAt` and
`dragPath`, with optional `pressure`, `tilt`, `orientation` and `buttons`. It needs that same root `adb shell` with the
`uinput` tool, and is refused before any input everywhere else.

`dragPath` points also take `pressure` and `tilt` (they need `pointer`), interpolated between points; `holdMs` and
`releaseHoldMs` become holds at the first and last point. A device or runner that cannot honour the request is refused before
anything is sent, naming the missing capability. `tilt`, `orientation` and `buttons` are Android only; `doubleTap` and a panel
`display` are not supported with a stylus yet. Details and the unverified parts are in the
[stylus design note](how-it-works/mcp/stylus-pressure-hover-injection.md).

### `hoverAt`

Hover enter, move and exit over `points` with no contact (Android only; the reasons iOS is refused are in the
[stylus design note](how-it-works/mcp/stylus-pressure-hover-injection.md)). It takes the `dragPath` point shape
(`x`, `y`, per-point `durationMs`) plus an optional per-point `distance` (stylus only), and the same
`coordinateSpace`, `display`, `snapshotId` and `layer`.

`toolType` chooses who hovers, and apps see the difference:

| `toolType`         | What the app receives                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `stylus` (default) | `ACTION_HOVER_*` with `TOOL_TYPE_STYLUS`, `SOURCE_STYLUS` and an `AXIS_DISTANCE` value    |
| `mouse`            | `ACTION_HOVER_*` with `TOOL_TYPE_MOUSE` and `SOURCE_MOUSE`; no distance; desktop-style UI |

It needs the `hover_input_v1` runner capability, or, for a `stylus` hover, an `adb shell` that already runs as
root with a writable `/dev/uinput` (after `adb root` on an emulator or userdebug build). A device or runner without either, and iOS, are refused before
anything is sent with the missing capability named, and a hover is never turned into a touch. CtrlProxy
advertises the capability and injects the hover through its `UiAutomation` instrumentation (see the
[stylus design note](how-it-works/mcp/stylus-pressure-hover-injection.md#instrumentation-route-13097)). The tool type, source
and hover actions above are confirmed on API 31 to 37 emulators; the stylus `AXIS_DISTANCE` value and physical pen
devices are unverified.

### prototype

Show agent-authored UI on a device: `show`, `patch`, `inspect`, `dismiss {id}` / `{all: true}`, `status`. Android can hold up to four prototypes (`replaceOthers: false`); iOS shows one at a time. Features (data model, gestures, checks) require the matching device capability and are refused before upload otherwise. Spec: [prototype UX](how-it-works/plat/android/prototype-ux.md). Camera and media support per runtime: [camera and media guide](how-it-works/prototype-camera-media.md).

#### Watch-sized mockups

Prototypes cannot run on watchOS, but a watch-sized spec gives a quick visual mockup of a watch
screen on an iPhone simulator or Android emulator. Float the window in the centre and give the root
`box` the watch screen's size, a large corner radius (which also clips its content) and a black
background:

| Case        | `width` × `height` (dp/pt) | `cornerRadius` |
| ----------- | -------------------------- | -------------- |
| 41 mm       | 176 × 215                  | 36             |
| 45 mm       | 198 × 242                  | 40             |
| 49 mm Ultra | 205 × 251                  | 44             |

```json
{
  "id": "watch-41mm",
  "window": {
    "placement": { "type": "floating", "gravity": "center", "offset": { "x": 0, "y": 0 } }
  },
  "components": {
    "watchRow": {
      "root": {
        "type": "row",
        "style": {
          "width": "fill",
          "background": "#222222",
          "cornerRadius": 16,
          "padding": { "start": 10, "end": 10, "top": 8, "bottom": 8 }
        },
        "children": [{ "type": "text", "text": "{props.title}", "style": { "color": "#FFFFFF" } }]
      }
    }
  },
  "root": {
    "type": "box",
    "style": {
      "width": { "dp": 176 },
      "height": { "dp": 215 },
      "cornerRadius": 36,
      "background": "#000000"
    },
    "children": [
      {
        "type": "scroll",
        "child": {
          "type": "column",
          "style": { "spacing": 6, "padding": { "start": 8, "end": 8, "top": 12 } },
          "children": [
            { "type": "use", "component": "watchRow", "props": { "title": "Drink water" } },
            { "type": "use", "component": "watchRow", "props": { "title": "Stand up" } }
          ]
        }
      }
    ]
  }
}
```

Put each common watch pattern in `components` and reuse it with `use`: a vertically scrolling list
of rows, a full-screen metric (one large number with a label and unit), a two-button confirmation
(two `button`s with `weight: 1` in a `row`, swapped in with `visibleWhen`), and a now-playing card
(title, artist, previous / play-pause / next `iconButton`s and a linear `progress`).

The mockup is a phone overlay sized like a watch. It does not simulate the Digital Crown, Always-On
or wrist-down dimming, real watchOS or Wear OS fonts and controls, or the round Wear OS screen, and
nothing runs on a watch. Check the final design on a real watch. To drive a watch app itself, see
[Apple Watch simulators](using/apple-watch.md).
