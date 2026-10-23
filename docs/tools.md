# 🧰 Tools

One toolset, three front doors: 💻 **CLI** (`bunx @kaeawc/auto-mobile --cli <tool>`), 🤖 **MCP**, 🌐 **daemon HTTP**. Same names, same args.

📋 Exact arguments live in the registered schema (`schemas/tool-definitions.json`) — availability varies by platform, runner, and feature gates.

## 🔌 Shared options

- 🆔 `sessionUuid` — pick a daemon device session.
- 📱 `platform` (Android/iOS) + `deviceId` — pick the device. A string `device` label needs `sessionUuid` and wins over `deviceId`.
- 🔆 `keepScreenAwake` — defaults to true on first Android setup of a physical device; pass `false` on that first call to skip. Cached per session; emulators and iOS ignore it.
- 👀 `raw` / `project` (`"skeleton"` default or `"full"`) — shape observation output on interaction tools.
- 🧾 `includeExtras: true` — keep raw accessibility `extras` in `structuredContent` only (use with `project: "full"` or `raw: true`).

## 👁️ Observe & navigate

| Tool                              | What it does                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------- |
| <code>observe</code>              | 📸 Screen hierarchy + screenshot. Synthetic `s2-` ids last one observation only. |
| <code>hitTest</code>              | 🎯 Preview candidates at a point, no input sent                                  |
| <code>highlight</code>            | ⭕ Circle an element                                                             |
| <code>snapshotOf</code>           | ✂️ Save a PNG crop of an element or rect                                         |
| <code>compareScreenshot</code>    | 🖼️ Visual regression baseline/compare                                            |
| <code>prototype</code>            | 🧪 Show/patch/dismiss a UI prototype overlay                                     |
| <code>identifyInteractions</code> | 💡 Suggest likely interactions                                                   |
| <code>explore</code>              | 🧭 Auto-explore to build the nav graph                                           |
| <code>getNavigationGraph</code>   | 🗺️ Inspect nav graph                                                             |
| <code>navigateTo</code>           | 🚀 Go to a screen via the graph                                                  |

📦 Screenshot paths are kept **at least 10 minutes after return** unless evicted early under pressure; the cap is **128 MiB and 4096 files**, with a process-start grace. Each result carries `screenshotExpiresAt`; new captures are never refused.

⌨️ Skeleton output lists actionable entries only. The collapsed keyboard marker `<ime>` is not a selector — use `sendKeys` or `keyboard`. It appears as at most one skeleton row, and only when the IME has at least one bounded accessible descendant.

## 👆 Interact

| Tool                       | What it does                                                             |
| -------------------------- | ------------------------------------------------------------------------ |
| <code>tapOn</code>         | 👉 Tap by text / desc / id / test tag                                    |
| <code>tapAny</code>        | 🖱️ Tap any clickable, scoped by container                                |
| <code>tapAt</code>         | 📍 Tap / long-press / double-tap at coords (native, normalized, percent) |
| <code>swipeOn</code>       | 📜 Swipe/scroll screen or element                                        |
| <code>swipeAt</code>       | ↗️ Swipe point to point                                                  |
| <code>dragAndDrop</code>   | 🫳 Drag element onto element                                             |
| <code>dragPath</code>      | 〰️ Drag along a timed polyline                                           |
| <code>pinchOn</code>       | 🤏 Pinch zoom                                                            |
| <code>multiTouch</code>    | ✋ 2–5 finger tap / press / swipe                                        |
| <code>sendKeys</code>      | ⌨️ Type, clear, raw keys, IME commands                                   |
| <code>keyboard</code>      | 🎹 Open/close/detect/select IME                                          |
| <code>selectAllText</code> | 🔤 Select all in focused input                                           |
| <code>setUIState</code>    | 📝 Set many form fields by desired state                                 |
| <code>clipboard</code>     | 📋 Copy/paste/clear/get                                                  |
| <code>pressButton</code>   | 🔘 Press device or nav button                                            |
| <code>homeScreen</code>    | 🏠 Go home                                                               |
| <code>recentApps</code>    | 🗂️ Open recents                                                          |
| <code>rotate</code>        | 🔄 Rotate orientation                                                    |
| <code>shake</code>         | 📳 Shake (emulator/simulator only)                                       |
| <code>systemTray</code>    | 🔔 Open/list/tap/dismiss notifications                                   |
| <code>wakeAndUnlock</code> | 🔓 Wake and unlock                                                       |
| <code>biometricAuth</code> | 🧬 Simulate biometrics                                                   |

## 📲 Apps, files & data

| Tool                               | What it does                                           |
| ---------------------------------- | ------------------------------------------------------ |
| <code>listApps</code>              | 📚 List installed apps                                 |
| <code>launchApp</code>             | ▶️ Launch by package                                   |
| <code>terminateApp</code>          | ⏹️ Terminate                                           |
| <code>installApp</code>            | ⬇️ Install                                             |
| <code>uninstallApp</code>          | 🗑️ Uninstall                                           |
| <code>crashApp</code>              | 💥 Crash on purpose                                    |
| <code>appLifecycle</code>          | ♻️ Background/kill for state-restoration tests         |
| <code>measureStartup</code>        | ⏱️ Cold/warm/hot startup stats                         |
| <code>openLink</code>              | 🔗 Open a URL                                          |
| <code>getDeepLinks</code>          | 🪝 Query deep links                                    |
| <code>setAppLinks</code>           | 🔐 Android App Links state                             |
| <code>inspectPackageSigning</code> | ✍️ Presence + signing                                  |
| <code>getAppPermissions</code>     | 🛂 Read permissions                                    |
| <code>setAppPermissions</code>     | ✅ Grant/revoke/reset permissions                      |
| <code>postNotification</code>      | 📣 Post a notification                                 |
| <code>getNotificationPolicy</code> | 🔕 Read notification/DND policy                        |
| <code>setNotificationPolicy</code> | 🔔 Set notification/DND policy                         |
| <code>sendBroadcast</code>         | 📡 Android explicit broadcast                          |
| <code>backgroundWork</code>        | 🛠️ Read/trigger background work                        |
| <code>getLogs</code>               | 📜 Logs with filters                                   |
| <code>resetAppLogs</code>          | 🧹 Reset named app log files                           |
| <code>putAppFile</code>            | 📥 Write files into app storage                        |
| <code>stageSessionDownloads</code> | 📥 Deprecated alias of `putAppFile`                    |
| <code>sqlQuery</code>              | 🗃️ SQL on app SQLite                                   |
| <code>listDataStores</code>        | 🗄️ List Jetpack DataStores                             |
| <code>getDataStore</code>          | 🔍 Read a DataStore                                    |
| <code>setKeyValue</code>           | ✏️ Set key-value entry                                 |
| <code>removeKeyValue</code>        | ➖ Remove key-value entry                              |
| <code>clearKeyValueFile</code>     | 🧽 Clear key-value file                                |
| <code>getPreference</code>         | 📖 Read system prop / SharedPreferences / UserDefaults |
| <code>setPreference</code>         | 🖊️ Write the same, with read-back                      |
| <code>resetKeychain</code>         | 🔑 Reset Keychain/Keystore                             |

📣 `postNotification` SDK compatibility: update the host first when the SDK contract changes.

## 📟 Devices & system state

| Tool                                     | What it does                               |
| ---------------------------------------- | ------------------------------------------ |
| <code>listDevices</code>                 | 📱 List booted devices                     |
| <code>listDeviceImages</code>            | 💿 List device images                      |
| <code>getAndroid</code>                  | 🤖 Find/recover an AVD                     |
| <code>getApple</code>                    | 🍎 Find/recover an iOS Simulator           |
| <code>provisionDevice</code>             | 🏗️ Provision an exact virtual device       |
| <code>setActiveDevice</code>             | 📌 Pin the active device                   |
| <code>killDevice</code>                  | 🔪 Kill a device                           |
| <code>deleteDevice</code>                | ☠️ Stop and delete, verified               |
| <code>deviceSnapshot</code>              | 📷 Capture/restore snapshot                |
| <code>getDeviceState</code>              | 🩺 Read device state incl. clock           |
| <code>setDeviceState</code>              | 🎛️ DND, connectivity, power, thermal…      |
| <code>getIosSimulatorCapabilities</code> | 🧬 iOS biometric capabilities              |
| <code>setDeviceResources</code>          | 🧮 Set resources, verify native state      |
| <code>reconcileDeviceResources</code>    | ⚖️ Report simulator resource drift         |
| <code>displayConfig</code>               | 🖥️ Font scale, density, dark mode          |
| <code>displayProfile</code>              | 📐 OEM display profile                     |
| <code>manufacturerProfile</code>         | 🏭 OEM manufacturer profile                |
| <code>killProfile</code>                 | 🪦 Simulate OEM background-kill policy     |
| <code>systemAlerts</code>                | 🚨 Auto-handle OS permission/system alerts |
| <code>changeLocalization</code>          | 🌍 Locale, tz, direction, calendar         |
| <code>statusBar</code>                   | 📶 Deterministic status bar                |
| <code>windowMode</code>                  | 🪟 Fullscreen / PiP / freeform             |
| <code>setPosture</code>                  | 📖 Foldable posture                        |
| <code>setSensor</code>                   | 🧭 Emulator virtual sensors                |
| <code>mediaSession</code>                | 🎵 Media session state/control             |
| <code>phoneCall</code>                   | ☎️ Simulate a call                         |
| <code>sendSms</code>                     | 💬 Simulate an SMS                         |

#### 🔎 Reading a device you do not own (`deviceId`)

👀 Reads never write settings on a device held or reserved by another session — they use what's already installed. A sessionless read of an **unheld** running device may ready it to answer (Android: CtrlProxy APK + accessibility; iOS: runner). Details: [which read tools ready an unheld device](using/device-ownership.md#which-read-tools-ready-an-unheld-device).

## 🌐 Network, plans & recording

| Tool                              | What it does                              |
| --------------------------------- | ----------------------------------------- |
| <code>network</code>              | 🕸️ Capture + error simulation             |
| <code>mockNetwork</code>          | 🎭 Add mock response rule                 |
| <code>clearMockNetwork</code>     | 🧼 Clear mock rules                       |
| <code>getNetworkGraph</code>      | 📊 Aggregate captured network graph       |
| <code>executePlan</code>          | ▶️ Run YAML plan (stops on first failure) |
| <code>exportPlan</code>           | 📤 Stop recording, export YAML plan       |
| <code>recordToolCalls</code>      | 🔴 Record MCP tool calls                  |
| <code>recordDeviceGestures</code> | 👆 Record on-device input                 |
| <code>performanceTrace</code>     | 📈 xctrace / Perfetto trace               |
| <code>videoRecording</code>       | 🎥 Start/stop video                       |

## ♿ Accessibility & session tools

| Tool                             | What it does                                 |
| -------------------------------- | -------------------------------------------- |
| <code>accessibility</code>       | ♿ Check/control a11y services               |
| <code>accessibilityAction</code> | 🦾 TalkBack-style action on an element       |
| <code>accessibilityFocus</code>  | 🎯 Set/clear TalkBack focus                  |
| <code>accessibilityAudit</code>  | 🔬 Platform a11y audit                       |
| <code>audit</code>               | 🕵️ On-demand screen audit                    |
| <code>barrier</code>             | 🚧 Sync devices, then run in parallel        |
| <code>criticalSection</code>     | 🔒 Sync devices, then run serially           |
| <code>setToolEnabled</code>      | 🎚️ Toggle `tools/list` discovery per session |

### 🧪 prototype

Show a full spec, `patch` it with `id` + `ops`, or dismiss it.

✅ **Checks** — devices advertising `prototype_checks_v1` validate inputs locally (`textField`, `slider`, `checkbox`, `switch`, `radioGroup`, `datePicker`, `timePicker`). Each input takes 1–8 `checks` plus `validateOn` (`change` | `blur` | `submit`). A check has a `message` and one rule: `required`, `minLength`/`maxLength`, `min`/`max`, `format` (email, phone, digits, decimal, url), or `pattern` (restricted, ≤128 units). Gate actions with `emit.requireValid`.

🔁 Long-running calls can run as MCP tasks, and results carry compact action metadata.
