# Tools

This page reflects the current MCP tool schema. Availability can still vary by
platform, runner, and enabled feature gates; inspect the registered schema for
the exact arguments supported by your connection.

## Observe & navigate

| Tool                                 | What it does                                               |
| ------------------------------------ | ---------------------------------------------------------- |
| 👀 <code>observe</code>              | Gets the current screen view hierarchy.                    |
| 🔍 <code>explore</code>              | Explores an app to build a navigation graph.               |
| 🗺️ <code>navigateTo</code>           | Navigates using the learned navigation graph.              |
| 📊 <code>getNavigationGraph</code>   | Retrieves the navigation graph for debugging.              |
| 🔗 <code>identifyInteractions</code> | Suggests likely interactions.                              |
| 🖍️ <code>highlight</code>            | Draws a visual highlight around a UI element.              |
| 🔍 <code>debugSearch</code>          | Shows selector matches, the chosen match, and near-misses. |

## Interact with the UI

| Tool                          | What it does                                                         |
| ----------------------------- | -------------------------------------------------------------------- |
| 👆 <code>tapOn</code>         | Taps by text, content description, resource ID, or Android test tag. |
| 🎯 <code>tapAny</code>        | Taps any clickable element, optionally scoped to a container.        |
| 👉 <code>swipeOn</code>       | Swipes or scrolls the screen or an element.                          |
| ↔️ <code>dragAndDrop</code>   | Drags one element to another.                                        |
| 🤏 <code>pinchOn</code>       | Pinches to zoom.                                                     |
| ⌨️ <code>inputText</code>     | Types text; its optional mode is Android-only.                       |
| 🧩 <code>setUIState</code>    | Sets multiple form fields to a desired state.                        |
| 🗑️ <code>clearText</code>     | Clears the focused input.                                            |
| ✨ <code>selectAllText</code> | Selects all text in the focused input.                               |
| ↩️ <code>imeAction</code>     | Performs an IME action.                                              |
| 🔘 <code>pressButton</code>   | Presses a device or navigation button.                               |
| ⌨️ <code>keyboard</code>      | Opens, closes, or detects the on-screen keyboard.                    |
| 📋 <code>clipboard</code>     | Copies, pastes, clears, or reads the clipboard.                      |

??? note "Pinch rotation semantics"

    <code>pinchOn.rotationDegrees</code> describes how far the two-finger axis rotates
    during the pinch. The fingers start horizontally and finish on the rotated
    axis, so a non-zero value combines pinch and rotation. The default <code>0</code> is
    a plain pinch. Android and iOS share this convention.

## Apps, files & app data

| Tool                                                                                             | What it does                                                                                                               |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 📱 <code>listApps</code>                                                                         | Lists installed apps on a device (params: `deviceId`, `type`, `search`, `profile`; default `type=user`).                   |
| 🚀 <code>launchApp</code>                                                                        | Launches an app by package name.                                                                                           |
| ❌ <code>terminateApp</code>                                                                     | Terminates an app by package name.                                                                                         |
| 💥 <code>crashApp</code>                                                                         | Intentionally crashes a running app through the platform crash path.                                                       |
| 📦 <code>installApp</code>                                                                       | Installs an APK, app bundle, or IPA.                                                                                       |
| 🗑️ <code>uninstallApp</code>                                                                     | Uninstalls an app by package name or bundle identifier.                                                                    |
| 🔗 <code>getDeepLinks</code>                                                                     | Queries an app's deep links.                                                                                               |
| 📄 <code>putAppFile</code>                                                                       | Writes local-file, UTF-8, or base64 content into an app container.                                                         |
| 📥 <code>stageSharedStorage</code>                                                               | Stages host-file, UTF-8, or base64 fixtures into a bounded Android Downloads namespace for system pickers (Android only).  |
| ⚙️ <code>getPreference</code> / ⚙️ <code>setPreference</code>                                    | Reads or writes Android system properties, SharedPreferences, or iOS UserDefaults.                                         |
| 🔑 <code>setKeyValue</code> / 🔑 <code>removeKeyValue</code> / 🔑 <code>clearKeyValueFile</code> | Manages an app key-value storage file.                                                                                     |
| 🗃️ <code>listDataStores</code> / 🗃️ <code>getDataStore</code>                                    | Lists or reads Android Jetpack DataStore entries with the SDK adapter.                                                     |
| 🗄️ <code>sqlQuery</code>                                                                         | Executes SQL against an app SQLite database.                                                                               |
| 🔐 <code>resetKeychain</code>                                                                    | Resets all Keychain data on an iOS Simulator after explicit confirmation; unsupported on Android and physical iOS devices. |

??? note "Intentional crash contract"

    <code>crashApp</code> accepts only an <code>appId</code>; it never accepts a PID,
    signal, or shell command. Android uses ActivityManager's VM-crash path for the
    resolved user. iOS Simulator sends SIGABRT to the exact launchd application
    process. Physical iOS devices return <code>supported: false</code> and never fall
    back to normal termination.

    Every result reports <code>success</code>, <code>supported</code>,
    <code>platform</code>, <code>appId</code>, <code>mechanism</code>,
    <code>timestamp</code>, and <code>confirmed</code>. It reports
    <code>wasRunning</code> whenever preflight established process state;
    confirmed crashes also report <code>processId</code> when available and include
    immediate OS diagnostic evidence. <code>success: true</code> and
    <code>confirmed: true</code> require fresh, target-specific crash evidence, not
    merely command dispatch or process disappearance.

??? example "Copy a fixture into an app container"

    ~~~json
    {
      "tool": "putAppFile",
      "params": {
        "platform": "ios",
        "target": {
          "domain": "app_containers",
          "appId": "com.example.app",
          "container": "documents"
        },
        "files": [
          {
            "sourcePath": "/Users/me/fixtures/welcome.png",
            "destinationPath": "fixtures/welcome.png"
          }
        ]
      }
    }
    ~~~

??? note "File containers"

    Android <code>externalFiles</code> maps to <code>/sdcard/Android/data/{appId}/files</code>.
    Private containers (<code>documents</code>, <code>cache</code>, and <code>tmp</code>) use
    <code>run-as</code> and require a debuggable app. iOS simulator containers include
    <code>documents</code>, <code>library</code>, <code>cache</code>, and <code>tmp</code>.

## Devices & system state

| Tool                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📋 <code>listDevices</code>                                                    | Lists booted devices; a note points to MCP resources for images and detail.                                                                                                                                                                                                                                                                                                                                                                                                            |
| 🖼️ <code>listDeviceImages</code>                                               | Lists available device images.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 🤖 <code>getAndroid</code> / 🍎 <code>getApple</code>                          | Finds or recovers an Android AVD or iOS Simulator for automation.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🧱 <code>provisionDevice</code>                                                | Provisions an exact virtual-device identity.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🔧 <code>setActiveDevice</code>                                                | Sets the active device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ❌ <code>killDevice</code> / 🧹 <code>deleteDevice</code>                      | Stops a device, or stops and permanently deletes it.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 📸 <code>deviceSnapshot</code>                                                 | Captures or restores a device snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🔄 <code>rotate</code>                                                         | Changes device orientation.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 🌐 <code>openLink</code>                                                       | Opens web URLs or routes app and universal deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 🧰 <code>homeScreen</code> / <code>recentApps</code> / <code>systemTray</code> | Controls core system surfaces and notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 🔓 <code>wakeAndUnlock</code>                                                  | Wakes and unlocks the keyguard.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🌍 <code>changeLocalization</code>                                             | Changes locale, time zone, text direction, time format, and calendar.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ⚙️ <code>getDeviceState</code> / ⚙️ <code>setDeviceState</code>                | Reads or changes Do Not Disturb, simulator biometric enrollment, and network condition. Degraded profiles — including `offline` — are best-effort cellular shaping on an Android emulator (`adb emu network …`/`gsm data off` plus a best-effort Wi-Fi disable), reported `partial`: they may not affect Wi-Fi or app traffic. Only reset to `none` is fully verified. A session restores the network to a clean `none` state on release. Unsupported on physical Android and all iOS. |
| 🧬 <code>getIosSimulatorCapabilities</code>                                    | Discovers biometrics for a selected iOS Simulator device type and runtime.                                                                                                                                                                                                                                                                                                                                                                                                             |
| 🫆 <code>biometricAuth</code>                                                  | Simulates biometric authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 📳 <code>shake</code>                                                          | Shakes an Android emulator or iOS Simulator.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 📞 <code>phoneCall</code> / 💬 <code>sendSms</code>                            | Simulates an Android emulator phone call or incoming SMS.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔔 <code>postNotification</code>                                               | Posts a notification through Android SDK hooks or iOS Simulator push.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 🔔 <code>getNotificationPolicy</code> / 🔔 <code>setNotificationPolicy</code>  | Reads or changes app notification and Do Not Disturb policy.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🛂 <code>getAppPermissions</code> / 🛂 <code>setAppPermissions</code>          | Reads or changes app permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Acquiring a device: `avdName`, `udid`, and the `deviceId` alias

`getAndroid` and `getApple` each accept two ways to name a target; pass one.

- **`getAndroid`** — `avdName` names a configured Android Virtual Device (the
  `name` field of `automobile:devices/images/android`). It is the identity
  AutoMobile uses to boot and coordinate a named AVD: the `avdName` path passes
  `matchExactName`, `androidAvdName`, and a `stableTarget` for exact AVD-identity
  and lifecycle coordination. `deviceId` is the copy-paste-from-discovery
  convenience: it accepts either an _already-booted_ serial such as
  `emulator-5554` (the `deviceId` field of `automobile:devices/booted/android`)
  **or** an AVD image name — if it names a defined-but-unbooted AVD, `getAndroid`
  cold-boots that image by name. The difference is the coordination hints the
  `avdName` path passes up front — `matchExactName`, an `androidAvdName`
  startup-lease hint, and an eager `stableTarget` — so prefer `avdName` when you
  specifically want to boot or coordinate a named AVD; use `deviceId` to attach
  to a running device or to boot straight from a discovered identifier.
- **`getApple`** — `udid` is the iOS Simulator UDID. `deviceId` is an accepted
  **alias** for `udid`: a booted simulator's `deviceId` (from
  `automobile:devices/booted/ios`) _is_ its `udid`, so both fields resolve to the
  same value.

The `deviceId` fields exist so the value that `listDevices` and the
`automobile:devices/booted/*` resources lead with can be copied straight into
`getAndroid`/`getApple` — the discovery→acquire path (#5870). See the
[FAQ](../../faq.md#how-do-i-see-or-start-a-device) for the CLI equivalents.

## Network, plans & recording

| Tool                                                           | What it does                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 🌐 <code>network</code>                                        | Controls network capture and error simulation.                                 |
| 🎭 <code>mockNetwork</code> / 🧹 <code>clearMockNetwork</code> | Adds or clears mock network response rules.                                    |
| 🕸️ <code>getNetworkGraph</code>                                | Returns the aggregate captured network graph.                                  |
| 🧪 <code>executePlan</code>                                    | Executes YAML plan steps and stops at the first failure.                       |
| 🔒 <code>criticalSection</code>                                | Synchronizes devices, then runs steps serially.                                |
| 🚧 <code>barrier</code>                                        | Synchronizes devices, then lets them proceed concurrently.                     |
| 📝 <code>recordSteps</code>                                    | Records MCP calls to YAML; begin and end require <code>--mcp-recording</code>. |
| ⏺️ <code>startTestRecording</code>                             | Starts recording user interactions for <code>exportPlan</code>.                |
| 📤 <code>exportPlan</code>                                     | Stops the active recording and exports a YAML plan.                            |
| 🎥 <code>videoRecording</code>                                 | Starts or stops device video recording.                                        |

## Accessibility & session tools

| Tool                               | What it does                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| ♿ <code>accessibility</code>      | Reads or controls Android TalkBack and iOS VoiceOver, returning fresh device state. |
| 🎯 <code>accessibilityFocus</code> | Sets or clears Android TalkBack focus by resource ID, text, or content description. |
| 🔀 <code>setToolEnabled</code>     | Enables or disables one exact AutoMobile tool for the current MCP session.          |

For the observe → act → observe behavior behind interaction tools, see the
[interaction loop](interaction-loop.md). For per-session public tool
selection, see [Dynamic Tools](../../using/dynamic-tools.md).
