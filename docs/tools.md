# 🧰 Tools

Every tool works from the **CLI** (`bunx @kaeawc/auto-mobile --cli <tool>`), **MCP**, or the **daemon** HTTP endpoint — same names, same arguments.

📖 Full arguments: the registered schema ([`schemas/tool-definitions.json`](https://github.com/kaeawc/auto-mobile/blob/main/schemas/tool-definitions.json)) or `automobile:tools`. Availability varies by platform and feature gates.

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
- 📱 `deviceId` — target a device explicitly on reads

### Reading a device you do not own (`deviceId`)

A read never writes settings on a device another session holds. A sessionless read of an unheld running device may ready it (install CtrlProxy / runner) to answer. See [which read tools ready an unheld device](using/device-ownership.md#which-read-tools-ready-an-unheld-device).

## 👀 Observe & navigate

| Tool                                 | What it does                                             |
| ------------------------------------ | -------------------------------------------------------- |
| 📸 <code>snapshotOf</code>           | Save a PNG crop of an element or screen rectangle        |
| 🆚 <code>compareScreenshot</code>    | Record or compare a named screenshot baseline            |
| 👁️ <code>observe</code>              | Read the current screen, hierarchy, and screenshot       |
| 🎯 <code>hitTest</code>              | Preview what a tap at a point would hit, without tapping |
| 🧭 <code>explore</code>              | Automatically explore app to build navigation graph      |
| 🗺️ <code>navigateTo</code>           | Navigate to screen using navigation graph                |
| 🕸️ <code>getNavigationGraph</code>   | Get navigation graph for debugging                       |
| 🔎 <code>identifyInteractions</code> | Suggest likely interactions                              |
| 🧪 <code>prototype</code>            | Show agent-authored UI on the device                     |
| 🔦 <code>highlight</code>            | Draw a red hand-drawn circle around a UI element         |

## 👆 Interact

| Tool                          | What it does                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| 📍 <code>tapAt</code>         | Tap, long press, or double tap at screen coordinates in native, normalized, or percent units |
| 👆 <code>tapOn</code>         | Tap an element by text, id, or test tag                                                      |
| 🤏 <code>tapAny</code>        | Tap any clickable element; scope with container or scrollableContainer                       |
| 👉 <code>swipeOn</code>       | Swipe/scroll on screen or elements                                                           |
| ↔️ <code>swipeAt</code>       | Swipe between two screen points                                                              |
| 🫳 <code>dragAndDrop</code>   | Drag and drop element                                                                        |
| 〰️ <code>dragPath</code>      | Drag a finger along a timed path                                                             |
| 🤌 <code>pinchOn</code>       | Pinch to zoom                                                                                |
| 🖐️ <code>multiTouch</code>    | Simultaneous 2-5 finger tap, long press, or swipe at a screen point                          |
| ⌨️ <code>sendKeys</code>      | Execute ordered typing, clear, raw-key, and semantic IME commands                            |
| 🧭 <code>focusNavigate</code> | Move D-pad focus to an element on Android TV; stops `focused`, `max_steps` or `stuck`        |
| 🎛️ <code>setUIState</code>    | Set multiple form fields by desired state                                                    |
| 📝 <code>selectAllText</code> | Select all text in focused input                                                             |
| 🔘 <code>pressButton</code>   | Press a device or navigation button                                                          |
| ⌨️ <code>keyboard</code>      | Open, close, detect, or switch the keyboard / IME                                            |
| 📋 <code>clipboard</code>     | Clipboard operations (copy/paste/clear/get)                                                  |

## 📦 Apps, files & data

| Tool                                  | What it does                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 🗂️ <code>listApps</code>              | List installed apps                                                                            |
| 🚀 <code>launchApp</code>             | Launch app by package name                                                                     |
| 🛑 <code>terminateApp</code>          | Terminate app by package name                                                                  |
| 💥 <code>crashApp</code>              | Intentionally crash a running app through the platform crash path                              |
| 🔄 <code>appLifecycle</code>          | Background-kill an app to test state restoration (Android; iOS background and SIGKILL)         |
| ⬇️ <code>installApp</code>            | Install app on device (.apk, split APKs, .apks, .aab, .app, or .ipa)                           |
| 🗑️ <code>uninstallApp</code>          | Uninstall app by package name or bundle identifier                                             |
| 🔏 <code>inspectPackageSigning</code> | Fresh read of one app's presence (installed/absent/unknown) and signing                        |
| 🔗 <code>getDeepLinks</code>          | Query app deep links                                                                           |
| 📥 <code>putAppFile</code>            | Write files into a bounded logical storage target                                              |
| 🧹 <code>resetAppLogs</code>          | Reset named app log files                                                                      |
| ⚙️ <code>getPreference</code>         | Read an Android system property, Android SharedPreferences key, or iOS UserDefaults key        |
| ⚙️ <code>setPreference</code>         | Write a system property, SharedPreferences, or UserDefaults key                                |
| 🗝️ <code>deleteKeychainItem</code>    | Delete one allowlisted app-owned iOS Keychain item (SDK opt-in, requires confirm)              |
| 🔑 <code>setKeyValue</code>           | Set app key-value storage entry                                                                |
| ❌ <code>removeKeyValue</code>        | Remove app key-value storage entry                                                             |
| 🧼 <code>clearKeyValueFile</code>     | Clear app key-value storage file                                                               |
| 🗄️ <code>listDataStores</code>        | List app Jetpack DataStore instances (Android, requires AutoMobile SDK adapter)                |
| 🗄️ <code>getDataStore</code>          | Read entries from an app Jetpack DataStore instance (Android, requires AutoMobile SDK adapter) |
| 🧮 <code>sqlQuery</code>              | Execute SQL on app SQLite database                                                             |
| 🔐 <code>resetKeychain</code>         | Reset an app's Keychain/Keystore state (scoped by appId)                                       |
| 🔗 <code>setAppLinks</code>           | Android 12+: change an app's App Links state so https links open the app directly (or not)     |
| ⏱️ <code>measureStartup</code>        | Measure cold/warm/hot app startup                                                              |
| 📜 <code>getLogs</code>               | Read device logs with filters                                                                  |
| 📡 <code>sendBroadcast</code>         | Send an Android broadcast to the app under test                                                |
| 🛠️ <code>backgroundWork</code>        | Android: read and trigger an app's background work without waiting hours                       |

## 📱 Devices & system

| Tool                                        | What it does                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| 📃 <code>listDevices</code>                 | List booted devices                                                                  |
| 💿 <code>listDeviceImages</code>            | List device images                                                                   |
| 🤖 <code>getAndroid</code>                  | Find or recover an Android AVD and prepare it for automation                         |
| 🍎 <code>getApple</code>                    | Find or recover an iOS Simulator and prepare it for automation                       |
| 🏗️ <code>provisionDevice</code>             | Provision exact virtual device                                                       |
| 🧰 <code>setDeviceResources</code>          | Set selected device resources and verify native state                                |
| ⚖️ <code>reconcileDeviceResources</code>    | Compare a simulator to a requested resource map                                      |
| ✅ <code>setActiveDevice</code>             | Pick the active device for this connection                                           |
| 🔌 <code>killDevice</code>                  | Kill device                                                                          |
| 🗑️ <code>deleteDevice</code>                | Stop and permanently delete a device, with verified platform-inventory absence       |
| 💾 <code>deviceSnapshot</code>              | Capture or restore device snapshot                                                   |
| 🔃 <code>rotate</code>                      | Rotate device orientation                                                            |
| 📐 <code>setPosture</code>                  | Set foldable / Duo posture                                                           |
| 📶 <code>statusBar</code>                   | Pin status-bar time, battery, and signal for clean screenshots                       |
| 🪟 <code>windowMode</code>                  | Fullscreen, PiP, or split-screen an Android task                                     |
| 🌍 <code>openLink</code>                    | Open URL in browser                                                                  |
| 🏠 <code>homeScreen</code>                  | Go to home screen                                                                    |
| 🕘 <code>recentApps</code>                  | Open recent apps                                                                     |
| 🔔 <code>systemTray</code>                  | System tray actions for notifications (open/close/list/find/tap/dismiss/clearAll)    |
| 🔓 <code>wakeAndUnlock</code>               | Wake a device and unlock its keyguard                                                |
| 🌍 <code>changeLocalization</code>          | Change locale, time zone, text direction, time format, and calendar system           |
| 🩺 <code>getDeviceState</code>              | Read clock, DND, connectivity, and other device state                                |
| 🔧 <code>setDeviceState</code>              | Set DND, airplane mode, and other device state                                       |
| 🖥️ <code>displayConfig</code>               | Read or set font scale, density, and display size                                    |
| 🎨 <code>displayProfile</code>              | Apply an OEM-style display profile (Android)                                         |
| 🍏 <code>getIosSimulatorCapabilities</code> | Discover biometric capabilities for a selected iOS Simulator device type and runtime |
| 🪪 <code>biometricAuth</code>               | Simulate biometric success or failure                                                |
| 📳 <code>shake</code>                       | Shake the device (simulator/emulator)                                                |
| 🧲 <code>setSensor</code>                   | Set an emulator sensor (accelerometer, gyro, …)                                      |
| 📞 <code>phoneCall</code>                   | Simulate an incoming phone call                                                      |
| 💬 <code>sendSms</code>                     | Simulate an incoming SMS                                                             |
| 🎵 <code>mediaSession</code>                | Read or control Android media sessions                                               |
| 📣 <code>postNotification</code>            | Post notification via Android SDK hooks or iOS Simulator simctl push                 |
| 🔕 <code>getNotificationPolicy</code>       | Read app notification/DND policy state                                               |
| 🔕 <code>setNotificationPolicy</code>       | Set app notification/DND policy state                                                |
| 🛂 <code>getAppPermissions</code>           | Read app permission state                                                            |
| 🛂 <code>setAppPermissions</code>           | userId grant/revoke; device-wide reset ['all']; no POST_NOTIFICATIONS                |
| ☠️ <code>killProfile</code>                 | Simulate an OEM background-kill policy (Android)                                     |
| 🏭 <code>manufacturerProfile</code>         | Approximate an OEM device (Android)                                                  |
| ⚠️ <code>systemAlerts</code>                | Auto-answer OS permission and system alerts                                          |

## 🌐 Network, plans & recording

| Tool                                 | What it does                                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📶 <code>network</code>              | Control network capture and error simulation                                                                                                                                      |
| 🎭 <code>mockNetwork</code>          | Add mock network response rule                                                                                                                                                    |
| 🧽 <code>clearMockNetwork</code>     | Clear mock network response rules                                                                                                                                                 |
| 🕸️ <code>getNetworkGraph</code>      | Get aggregate captured network graph                                                                                                                                              |
| ▶️ <code>executePlan</code>          | Execute YAML plan steps; stops on first failed step                                                                                                                               |
| 🔒 <code>criticalSection</code>      | Synchronize multiple devices at a barrier, then run steps serially                                                                                                                |
| 🚧 <code>barrier</code>              | Sync multiple devices at a point in a plan                                                                                                                                        |
| ⏺️ <code>recordToolCalls</code>      | Record MCP tool calls to YAML                                                                                                                                                     |
| 🎬 <code>recordDeviceGestures</code> | Start recording on-device user input (not tool calls) for exportPlan                                                                                                              |
| 📤 <code>exportPlan</code>           | Stop active recording and export a YAML plan                                                                                                                                      |
| 🎥 <code>videoRecording</code>       | Start or stop device video recording                                                                                                                                              |
| 📈 <code>performanceTrace</code>     | Record an xctrace / Perfetto trace                                                                                                                                                |
| 🔬 <code>captureTrace</code>         | Android: record a Perfetto trace from typed categories (`sched`, `gfx`, `view`, `am`, `wm`, `binder_driver`, `memory`, `app`); `stop` pulls the `.perfetto-trace`. Off by default |
| 🧠 <code>heapDump</code>             | Android: dump a debuggable or profileable app's heap to a host `.hprof` (`heap_dump_not_debuggable` otherwise). Off by default                                                    |

## ♿ Accessibility & tooling

| Tool                                | What it does                                                            |
| ----------------------------------- | ----------------------------------------------------------------------- |
| 🦮 <code>accessibility</code>       | Check or control accessibility services                                 |
| 🎯 <code>accessibilityFocus</code>  | Set or clear Android TalkBack focus by resourceId, text, or contentDesc |
| 🫶 <code>accessibilityAction</code> | Perform a TalkBack-style accessibility action (Android)                 |
| ✅ <code>accessibilityAudit</code>  | Run the platform's own accessibility audit engine on the current screen |
| 🧾 <code>audit</code>               | Audit the current screen on demand                                      |
| 🧩 <code>setToolEnabled</code>      | Show or hide tools in discovery                                         |

## 📺 Android TV focus navigation

`focusNavigate({ until, direction?, maxSteps?, settleMs? })` (#14947) drives focus-based UIs. It observes, and
while the input-focused element (`focusedElement`) does not match `until` (`text`, `contentDesc` and/or `resourceId`) it
presses the D-pad arrow toward the nearest match, or `direction` when given, then observes again. With no focused
element or no match on screen it presses down. It returns the `path` of focused elements and a `status`: `focused`,
`max_steps` (default 30, at most 100) or `stuck` (two presses left focus unchanged). Activate the focused item
afterwards with `sendKeys` key `enter`; Android treats `KEYCODE_ENTER` and `KEYCODE_DPAD_CENTER` both as select, so no
separate `select` key exists. Android only; not yet verified on a TV image
(see `docs/design-docs/plat/android/form-factors.md`).

## 📝 Notes

- ⌨️ Compact observations fold soft-keyboard keys into one `keyboard: { visible: true, package: "…" }` summary plus at most one skeleton row (`<ime> | Keyboard (…) | input`). The row appears only with at least one bounded accessible descendant.
- 📸 Screenshot paths are kept for **at least 10 minutes after return** unless evicted early under capacity pressure; each path has a `screenshotExpiresAt`/`expiresAt` (host epoch ms, not a promise). Retention starts at **128 MiB** and scales by 64 MiB per active device up to 1 GiB, within a limit of **4096 files**. Each device’s newest 3 screenshots (counting its incoming frame) are evicted only as a last resort, and a capture is admitted even if nothing fits. The byte limits and per-device allowance are [configurable](using/environment-variables.md#screenshot-retention). After a restart, existing files get a process-start grace of ten minutes.
- 🧹 `holdSessionOnFailure` keeps plan sessions instead of auto-releasing them.

### prototype

Show agent-authored UI on a device: `show`, `patch`, `inspect`, `dismiss {id}` / `{all: true}`, `status`. Android can hold up to four prototypes (`replaceOthers: false`); iOS shows one at a time. Features (data model, gestures, checks) require the matching device capability and are refused before upload otherwise. Spec: [prototype UX](design-docs/plat/android/prototype-ux.md).
