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
| 📱 <code>listApps</code>                                                                         | Provides guidance for listing installed apps through MCP resources.                                                        |
| 🚀 <code>launchApp</code>                                                                        | Launches an app by package name.                                                                                           |
| ❌ <code>terminateApp</code>                                                                     | Terminates an app by package name.                                                                                         |
| 📦 <code>installApp</code>                                                                       | Installs an APK, app bundle, or IPA.                                                                                       |
| 🗑️ <code>uninstallApp</code>                                                                     | Uninstalls an app by package name or bundle identifier.                                                                    |
| 🔗 <code>getDeepLinks</code>                                                                     | Queries an app's deep links.                                                                                               |
| 📄 <code>putAppFile</code>                                                                       | Writes local-file, UTF-8, or base64 content into an app container.                                                         |
| ⚙️ <code>getPreference</code> / ⚙️ <code>setPreference</code>                                    | Reads or writes Android system properties, SharedPreferences, or iOS UserDefaults.                                         |
| 🔑 <code>setKeyValue</code> / 🔑 <code>removeKeyValue</code> / 🔑 <code>clearKeyValueFile</code> | Manages an app key-value storage file.                                                                                     |
| 🗃️ <code>listDataStores</code> / 🗃️ <code>getDataStore</code>                                    | Lists or reads Android Jetpack DataStore entries with the SDK adapter.                                                     |
| 🗄️ <code>sqlQuery</code>                                                                         | Executes SQL against an app SQLite database.                                                                               |
| 🔐 <code>resetKeychain</code>                                                                    | Resets all Keychain data on an iOS Simulator after explicit confirmation; unsupported on Android and physical iOS devices. |

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

| Tool                                                                           | What it does                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 📋 <code>listDevices</code>                                                    | Provides guidance for listing devices through MCP resources.               |
| 🖼️ <code>listDeviceImages</code>                                               | Lists available device images.                                             |
| 🤖 <code>getAndroid</code> / 🍎 <code>getApple</code>                          | Finds or recovers an Android AVD or iOS Simulator for automation.          |
| 🧱 <code>provisionDevice</code>                                                | Provisions an exact virtual-device identity.                               |
| 🔧 <code>setActiveDevice</code>                                                | Sets the active device.                                                    |
| ❌ <code>killDevice</code> / 🧹 <code>deleteDevice</code>                      | Stops a device, or stops and permanently deletes it.                       |
| 📸 <code>deviceSnapshot</code>                                                 | Captures or restores a device snapshot.                                    |
| 🔄 <code>rotate</code>                                                         | Changes device orientation.                                                |
| 🌐 <code>openLink</code>                                                       | Opens web URLs or routes app and universal deep links.                     |
| 🧰 <code>homeScreen</code> / <code>recentApps</code> / <code>systemTray</code> | Controls core system surfaces and notifications.                           |
| 🔓 <code>wakeAndUnlock</code>                                                  | Wakes and unlocks the keyguard.                                            |
| 🌍 <code>changeLocalization</code>                                             | Changes locale, time zone, text direction, time format, and calendar.      |
| ⚙️ <code>getDeviceState</code> / ⚙️ <code>setDeviceState</code>                | Reads or changes Do Not Disturb and simulator biometric enrollment.        |
| 🧬 <code>getIosSimulatorCapabilities</code>                                    | Discovers biometrics for a selected iOS Simulator device type and runtime. |
| 🫆 <code>biometricAuth</code>                                                  | Simulates biometric authentication.                                        |
| 📳 <code>shake</code>                                                          | Shakes an Android emulator or iOS Simulator.                               |
| 📞 <code>phoneCall</code> / 💬 <code>sendSms</code>                            | Simulates an Android emulator phone call or incoming SMS.                  |
| 🔔 <code>postNotification</code>                                               | Posts a notification through Android SDK hooks or iOS Simulator push.      |
| 🔔 <code>getNotificationPolicy</code> / 🔔 <code>setNotificationPolicy</code>  | Reads or changes app notification and Do Not Disturb policy.               |
| 🛂 <code>getAppPermissions</code> / 🛂 <code>setAppPermissions</code>          | Reads or changes app permissions.                                          |

## Network, plans & recording

| Tool                                                           | What it does                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 🌐 <code>network</code>                                        | Controls network capture and error simulation.                                            |
| 🎭 <code>mockNetwork</code> / 🧹 <code>clearMockNetwork</code> | Adds or clears mock network response rules.                                               |
| 🕸️ <code>getNetworkGraph</code>                                | Returns the aggregate captured network graph.                                             |
| 🧪 <code>executePlan</code>                                    | Executes YAML plan steps and stops at the first failure.                                  |
| 🔒 <code>criticalSection</code>                                | Synchronizes devices, then runs steps serially.                                           |
| 🚧 <code>barrier</code>                                        | Synchronizes devices, then lets them proceed concurrently.                                |
| 📝 <code>recordSteps</code>                                    | Records MCP calls to YAML; begin and end require <code>--mcp-recording</code>.            |
| ⏺️ <code>startTestRecording</code>                             | Starts recording user interactions for <code>exportPlan</code>.                           |
| 📤 <code>exportPlan</code>                                     | Stops the active recording and exports a YAML plan.                                       |
| 🎥 <code>videoRecording</code>                                 | Starts or stops device video recording.                                                   |
| 🐛 <code>bugReport</code>                                      | Saves screen state, hierarchy, logs, window info, and a screenshot to a shareable report. |

## Accessibility & session tools

| Tool                               | What it does                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| ♿ <code>accessibility</code>      | Reads or controls Android TalkBack and iOS VoiceOver, returning fresh device state. |
| 🎯 <code>accessibilityFocus</code> | Sets or clears Android TalkBack focus by resource ID, text, or content description. |
| 🔀 <code>setToolEnabled</code>     | Enables or disables one exact AutoMobile tool for the current MCP session.          |

For the observe → act → observe behavior behind interaction tools, see the
[interaction loop](interaction-loop.md). For per-session public tool
selection, see [Dynamic Tools](../../using/dynamic-tools.md).
