# Tools

> All tools listed here are <kbd>✅ Implemented</kbd> and <kbd>🧪 Tested</kbd> unless noted otherwise. See the [Status Glossary](../status-glossary.md) for chip definitions.

#### Observe

Almost all other tool calls have built-in observation via the [interaction loop](interaction-loop.md), but we also have a standalone [observe](observe/index.md) tool that specifically performs just that action to get the AI agent up to speed. Its `waitFor` DSL can wait for `appear`, `disappear`, `clickable`, `textEquals`, `countStable`, or whole-screen `stable`; wait responses include the final observation, state, poll count, elapsed time, and relevant match or timeout candidates. The legacy `waitFor` forms remain supported.

#### Interactions

- 👆 `tapOn` supports tap, double-tap, long press, and long-press drag actions. Selectors include `selector.text`, `selector.textAny`, and `selector.elementId`; `sibling: true` taps a clickable sibling of the selector match. When multiple elements match, `index` (0-based) taps the Nth on-screen match instead of applying `selectionStrategy`.
- 👉 `swipeOn` handles directional swipes and scrolling within container bounds.
- ↔️ `dragAndDrop` for element-to-element moves.
- 🔍 `pinchOn` for zoom in/out gestures.
- 📳 `shake` for accelerometer simulation.

All Interactions tools — including `pinchOn`, which routes coordinate-based pinch/zoom through the runner's synthesized two-finger events — run on **Android** (physical devices and emulators) and **iOS** via the XCUITest CtrlProxy runner. iOS support is currently <kbd>📱 Simulator Only</kbd> (see the [iOS overview](../plat/ios/index.md)). `shake` is the one exception with no physical-iOS path even once physical support lands, because XCTest exposes no shake API for real devices — it returns an actionable error there.

> **`pinchOn` `rotationDegrees` semantics.** `rotationDegrees` (default `0`) is how far the two-finger axis rotates *during* the pinch: the fingers start on the horizontal axis and finish on an axis rotated by `rotationDegrees`. A non-zero value therefore performs a combined **pinch + rotate**, not a pinch along a fixed rotated axis. The default `0` is a plain pinch/zoom and is unaffected. Both the Android and iOS runners deliberately share this convention so pinch results match across platforms — if you ever change it, change both runners together (see issue #2911). **Decision (#2911):** this start-horizontal / end-rotated behavior is intentional and documented rather than changed, to preserve existing cross-platform pinch results; revisit only if a concrete caller needs a pinch along a fixed rotated axis, and then only as a coordinated Android + iOS change.

#### App Management

- 📱 Installed apps are exposed via the `automobile:apps` resource with query filters.
- 🚀 `launchApp` starts apps by package name (with optional clear-app-data support).
- ❌ `terminateApp` force-stops an app by package name.
- 📦 `installApp` installs an APK.
- 📄 `putAppFile` writes a local file, UTF-8 text, or base64 binary content into logical app containers such as `documents`, `cache`, `tmp`, and `externalFiles`.
- 🔗 `getDeepLinks` reads registered deep links/intent filters for an Android package.

Copy a fixture into an app container:

```json
{
  "tool": "putAppFile",
  "params": {
    "appId": "com.example.app",
    "container": "documents",
    "sourcePath": "/Users/me/fixtures/welcome.png",
    "destinationPath": "fixtures/welcome.png",
    "platform": "ios"
  }
}
```

Write inline configuration without a temporary file:

```json
{
  "tool": "putAppFile",
  "params": {
    "appId": "com.example.app",
    "container": "documents",
    "contentText": "{\"experiments\":{\"newOnboarding\":false}}",
    "destinationPath": "config/experiments.json",
    "platform": "android"
  }
}
```

After writing, use `automobile:devices/{deviceId}/apps/{appId}/files/{container}` to list files or `automobile:devices/{deviceId}/apps/{appId}/files/{container}/{path}` to read one back. Prefer this API over direct `adb push`, `run-as`, or `simctl get_app_container` copy commands.

Android app files support `externalFiles` through `/sdcard/Android/data/{appId}/files`. Use this for app-readable fixture files that do not require private app storage:

```json
{
  "tool": "putAppFile",
  "params": {
    "appId": "com.example.app",
    "container": "externalFiles",
    "sourcePath": "/Users/me/fixtures/document.pdf",
    "destinationPath": "fixtures/document.pdf",
    "platform": "android"
  }
}
```

Android private containers (`documents`, `cache`, and `tmp`) use `run-as {appId}` and require a debuggable app build. Non-debuggable apps fail with an actionable error instead of reporting a successful write. `library` is not an Android container; use `documents`, `cache`, `tmp`, or `externalFiles`.

iOS app files are supported for simulators through `xcrun simctl get_app_container {deviceId} {bundleId} data`. Logical containers map to the app data container as follows:

| Container | iOS path |
|-----------|----------|
| `documents` | `Documents` |
| `library` | `Library` |
| `cache` | `Library/Caches` |
| `tmp` | `tmp` |

Use `documents` for user-visible fixtures, `cache` for cache-like test data, and `tmp` for temporary files:

```json
{
  "tool": "putAppFile",
  "params": {
    "appId": "com.example.app",
    "container": "cache",
    "contentBase64": "AAEC/w==",
    "destinationPath": "fixtures/image.bin",
    "platform": "ios"
  }
}
```

Manual emulator validation for Android:

```sh
printf '{"enabled":true}\n' > /tmp/automobile-settings.json
# Call putAppFile with appId=com.example.app, container=externalFiles,
# sourcePath=/tmp/automobile-settings.json, destinationPath=config/settings.json.
adb shell cat /sdcard/Android/data/com.example.app/files/config/settings.json
```

Manual simulator validation for iOS:

```sh
printf 'hello simulator\n' > /tmp/automobile-ios-fixture.txt
# Call putAppFile with appId=com.example.app, container=documents,
# sourcePath=/tmp/automobile-ios-fixture.txt, destinationPath=fixtures/hello.txt.
APP_CONTAINER=$(xcrun simctl get_app_container booted com.example.app data)
cat "$APP_CONTAINER/Documents/fixtures/hello.txt"
```

#### Input Methods

- ⌨️ `inputText` and `imeAction` for typing and IME actions.
- 🗑️ `clearText` and `selectAllText` act on the focused field.
- 🔘 `pressButton` or `pressKey` for back/home/recent/power/volume.

#### Device Configuration

- 🔄 `rotate` sets portrait or landscape.
- 🌐 `openLink` launches URLs or deep links.
- 🧰 `systemTray`, `homeScreen`, and `recentApps` control system surfaces.
- 🔔 `postNotification` posts notifications from the app-under-test when SDK hooks are installed.
- 🌍 `changeLocalization` sets locale, time zone, text direction, and time format in one call. Android locale changes require `appId`; Android 13+ uses non-root app-scoped locales, while older Android versions automatically verify root-capable ADB before using the system locale fallback.

#### Navigation & Exploration

- 🗺️ `navigateTo` navigates to a specific screen using learned paths from the navigation graph.
- 🔍 [`explore`](nav/explore.md) automatically explores the app and builds the navigation graph by intelligently selecting and interacting with UI elements.
- 📊 `getNavigationGraph` retrieves the current navigation graph for debugging and analysis.

#### Advanced Device Management

- 📋 Device inventory and pool status are exposed via the `automobile:devices/booted` resource.
- 🚀 `startDevice` starts a device with the specified device image.
- 🧱 `provisionDevice` creates or adopts an exact virtual-device identity. It requires the `device-control` capability.
- ❌ `killDevice` terminates a running device.
- 🔧 `setActiveDevice` sets the active device for subsequent operations. It is a
  compatibility API; new multi-client daemon integrations should bind a
  device-pool session when the MCP connection starts.

#### Testing & Debugging {#testing-debugging}

- 🧪 `executePlan` (daemon mode only) executes a series of tool calls from a YAML plan content, stopping if any step fails.
- 🔒 `criticalSection` (daemon mode only) coordinates multiple devices at a synchronization barrier for serialized steps.
- 🩺 `doctor` runs diagnostic checks to verify AutoMobile setup and environment configuration.
- 🐛 `bugReport` generates a comprehensive bug report including screen state, view hierarchy, logcat, screenshot, and optional highlight metadata.
- 🔍 `debugSearch` debugs element search operations to understand why elements aren't found or wrong elements are selected.
- 📸 `rawViewHierarchy` gets raw view hierarchy data (XML/JSON) without parsing for debugging.
- 🖍️ `highlight` draws visual overlays to highlight areas of the screen during debugging. <kbd>🤖 Android</kbd> <kbd>🍎 iOS</kbd>
- 🔗 `identifyInteractions` suggests likely interactions with ready-to-use tool calls (debug-only; enable the debug feature flag).

#### Network & Connectivity

- `setNetworkState` — Wi-Fi, cellular, and airplane mode control. ADB commands validated on API 35. <kbd>❌ Not Implemented</kbd> *(MCP tool not yet built; see [network-state.md](../plat/android/network-state.md))*

#### Accessibility

- `setTalkBackEnabled`, `setA11yFocus`, `announce` — TalkBack simulation and enablement. ADB commands validated. <kbd>❌ Not Implemented</kbd> *(MCP tools not yet built; see [talkback.md](../plat/android/talkback.md))*

#### Daemon & Session Management

- 📋 Device pool status is exposed via the `automobile:devices/booted` resource.
- Daemon management and IDE operations are exposed via the [Unix Socket API](daemon/unix-socket-api.md) (not MCP tools).
