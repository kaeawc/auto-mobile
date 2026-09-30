# Tools

Every tool below can be driven three ways: from the **CLI**
(`bunx @kaeawc/auto-mobile --cli <tool>`), over **MCP** from an AI client, or
directly against the **daemon**'s HTTP endpoint. The tool names and arguments are
the same across all three.

This page reflects the current tool schema. Availability can still vary by
platform, runner, and enabled feature gates; inspect the registered schema for
the exact arguments supported by your connection.

## Observe & navigate

`observe` accepts an optional `display` panel key, a panel role (`inner`,
`cover`, `rear`, or `external`), or `"active"`. With no argument, it follows
the focused window's panel when available, then the current posture's default
panel. The returned `display` stamp identifies the panel actually observed.
For Android it uses the physical panel key from the hierarchy's `panelUniqueId`
or mapped `displayId`; for iOS it uses the matched simulator screen name. Its
`role` comes from inventory. Android foldables include the current device-state
`posture` when available; iOS and single-panel devices report `unknown`.
When inventory has two or more panels, `otherDisplays` lists each remaining
panel's `key`, `role`, and pixel `size` (`width`, `height`).
`display: "all"` is not supported yet. Android routes the hierarchy and
screenshot reads to the selected display; on iOS, only the currently live
simulator panel can be observed. This selector does not route interaction tools.

### Screen-coordinate contract

`observe` reports platform-native, current-orientation screen coordinates. The
origin is the top-left of the complete current screen, including system UI:

- Android uses physical pixels; iOS uses XCTest logical points.
- `screenSize`, skeleton bounds, full-hierarchy bounds, and future absolute
  coordinate input use that same platform-native coordinate space.
- Valid coordinates are half-open: `0 <= x < width` and `0 <= y < height`.
- A point already in the platform-native space is not density-, inset-,
  Retina-scale-, canonical-pixel-, or rotation-transformed.

This is separate from the daemon observation-stream's
[canonical-pixel mapping](design-docs/mcp/daemon/screen-control-mapping.md).
That stream contract is intentional and does not transform MCP `observe` or
native absolute-input coordinates.

`observe`, `observe.screenSize`, and `tapAt` use the device's current-orientation
native coordinate space described above. For a fresh screenshot matching an
observation, call `observe({ screenshot: "settled" })` and read its
`screenshotPath`. The screenshot's orientation follows the device framebuffer:
on the iOS Simulator, the framebuffer can remain portrait after `rotate`, even
while the device orientation is landscape (this is simulator framebuffer
behavior, not an AutoMobile bug); on Android, the raster rotates with the
device. Therefore, after rotation, callers must apply a platform- and orientation-specific
transform before correlating iOS `observe` or `tapAt` coordinates with
`observe` screenshot pixels. No such transform is needed on Android. The
`screenshotOrientation` field identifies the returned raster orientation.

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

| Tool                          | What it does                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 👆 <code>tapOn</code>         | Taps by text, content description, resource ID, or Android test tag; can idempotently ensure a toggle is checked or unchecked. |
| 🎯 <code>tapAny</code>        | Taps any clickable element, optionally scoped to a container.                                                                  |
| 👉 <code>swipeOn</code>       | Swipes or scrolls the screen or an element.                                                                                    |
| ↔️ <code>dragAndDrop</code>   | Drags one element to another.                                                                                                  |
| 🤏 <code>pinchOn</code>       | Pinches to zoom.                                                                                                               |
| ⌨️ <code>sendKeys</code>      | Runs ordered text, clear, raw-key, and semantic-key commands.                                                                  |
| 🧩 <code>setUIState</code>    | Sets multiple form fields to a desired state.                                                                                  |
| ✨ <code>selectAllText</code> | Selects all text in the focused input.                                                                                         |
| 🔘 <code>pressButton</code>   | Presses a device or navigation button.                                                                                         |
| ⌨️ <code>keyboard</code>      | Opens, closes, or detects the keyboard; selects AutoMobile profiles or installed Android IMEs.                                 |
| 📋 <code>clipboard</code>     | Copies, pastes, clears, or reads the clipboard.                                                                                |

On Android, `keyboard` can list installed input methods with
`{"action":"listImes"}` and select an enabled component with
`{"action":"setIme","imeId":"…"}`. To exercise one visible key in an installed
IME, focus an editor first, then call
`{"action":"tapImeKey","imeId":"…","key":"a"}`. This action selects the requested
IME for one frame-bound physical tap, reports whether the same focused editor
changed without returning its text, and restores the original active IME.
The requested component must already be installed and enabled; the key must
have one visible, package-owned accessibility match inside an IME window.
Unobservable or ambiguous keys fail closed. If restoration cannot be verified,
AutoMobile quarantines further IME changes until restart.

`sendKeys` accepts one optional field selector and an ordered sequence of up to
100 commands:

```json
{
  "selector": { "text": "Email" },
  "commands": [
    { "action": "type", "text": "name@example.com" },
    { "action": "key", "key": "tab" },
    { "action": "type", "text": "replacement", "operation": "replace", "mode": "a11y" },
    { "action": "key", "key": "enter", "modifiers": ["shift"] }
  ]
}
```

Text defaults to `operation: "insert"` and `mode: "auto"`. On Android, `auto`
uses AutoMobile's IME when the installed CtrlProxy APK advertises commit and
cancellation support. Older APKs fall back to `eventAll` for insertion and
`a11y` for replacement. Modes `ime`, `imeKeyEvents`, `a11y`, `eventLast`,
`eventAll`, and `eventOnly` select a delivery strategy explicitly; `eventAll`
sends Android key events for apps that depend on them. `imeKeyEvents` is an
opt-in Android experiment that sends printable ASCII as soft-keyboard events
through the active `InputConnection`. It preflights the whole string and
rejects unsupported characters before sending any events; it requires an APK
advertising `ime_key_events_v1`. No additional Android permission or manifest
entry is required. A successful result confirms event dispatch, not the target
editor's final text; inspect the returned observation when using this mode.
iOS accepts the same values for cross-platform plans and
reports the actual `xcuiTypeText` mechanism as
`resolvedMode`. Raw keys are `enter`, `tab`,
`escape`, `backspace`, `delete`, and the four arrow keys; they accept `shift`,
`ctrl`, `alt`, and `meta`. Semantic keys `next`, `previous`, `done`, `search`,
`send`, and `go` perform the corresponding IME action and ignore modifiers. A
standalone `{ "action": "clear" }` command clears the focused field. Execution
stops on the first failure and returns compact command metadata plus the final
observation without copying type-command text into the metadata.

| Platform / mode                                | Unicode text, including emoji                            | Delivery                                                                                                                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS, any requested mode                        | Supported; the requested mode resolves to `xcuiTypeText` | XCUITest `typeText` receives the whole string.                                                                                                                                                                                                        |
| Android `a11y`                                 | Supported                                                | Accessibility `ACTION_SET_TEXT` writes the whole string.                                                                                                                                                                                              |
| Android `ime`, or `auto` when IME is available | Supported                                                | CtrlProxy IME delivers complete graphemes through `InputConnection`; `auto` can fall back as described above.                                                                                                                                         |
| Android `eventAll`, `eventLast`                | Supported with split delivery                            | ASCII uses key events; other text uses accessibility insertion. A keycap, decomposed letter, or ASCII followed by ZWJ can split after its ASCII base, leaving an accessibility insertion beginning with a combining mark, variation selector, or ZWJ. |
| Android `eventOnly`, `imeKeyEvents`            | ASCII only                                               | `eventOnly` preflights available key events; `imeKeyEvents` accepts printable ASCII only. Unsupported text fails before editing.                                                                                                                      |

Use `ime` or `a11y` for emoji and other Unicode text when complete grapheme
delivery matters. `auto` uses the IME when available, but its Android insertion
fallback can split graphemes across key events and accessibility inserts.
`SendKeysCommandResult.textLength` counts Unicode code points, rather than
graphemes or UTF-16 code units. On iOS, XCUITest `typeText` supplies the text
independently of the active keyboard layout; the UI regression corpus checks
non-Latin strings with the simulator's current keyboard configuration, but does
not switch among keyboard layouts. If simulator typing does not enter text,
check the **Connect Hardware Keyboard** setting.

#### Unicode behavior by `sendKeys` mode

The following describes the current delivery path. Event-based modes classify
Unicode code points individually; they do not preserve grapheme boundaries.

| Mode                                     | Non-ASCII                                              | Emoji (including surrogate pairs and ZWJ sequences)                                       | Combining marks                                                                         | CJK                                                    | Notes                                                                                                                                                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS `xcuiTypeText` (all requested modes) | Passed as one string                                   | Passed as one string                                                                      | Passed as one string                                                                    | Passed as one string                                   | Uses XCUITest `typeText` through the text client.                                                                                                                                                                                                    |
| Android `a11y`                           | Passed intact                                          | Passed intact, including surrogate pairs and ZWJ                                          | Passed intact with its base                                                             | Passed intact                                          | Uses accessibility text insertion.                                                                                                                                                                                                                   |
| Android `ime`                            | Committed intact                                       | Committed as supplied                                                                     | Committed with its base                                                                 | Committed intact                                       | Uses the CtrlProxy commit IME; final editor rendering depends on the IME/editor.                                                                                                                                                                     |
| Android `eventAll`                       | Unsupported runs inserted intact                       | Unsupported runs, including ZWJ sequences, inserted intact                                | An ASCII base such as `e` is a key event and its following mark is a separate insertion | Inserted intact                                        | ASCII code points use key events; consecutive unsupported code points are grouped into accessibility inserts. For example, `é` dispatches `e` then inserts only U+0301, and `1️⃣` dispatches `1` then inserts the variation selector and keycap mark. |
| Android `eventLast`                      | Passed intact when no ASCII key-event character occurs | Passed intact when no ASCII key-event character occurs; ASCII neighbors may cause a split | A trailing mark after ASCII `e` is inserted separately after the `e` key event          | Passed intact when no ASCII key-event character occurs | Sends the last supported ASCII key event, with preceding and following text inserted through accessibility.                                                                                                                                          |
| Android `eventOnly`                      | Rejected before mutation                               | Rejected before mutation                                                                  | Rejected before mutation                                                                | Rejected before mutation                               | Preflights the entire string and fails at the first character without a key-event plan.                                                                                                                                                              |

For event-based delivery, surrogate pairs stay together during code-point
iteration, so an accessibility insertion does not begin with a low surrogate.
A grapheme containing an ASCII key-event character can still be split across
delivery mechanisms, and its accessibility insertion may begin with a lone
combining mark, variation selector, or ZWJ. Tests pin the dispatched text
chunks; they do not claim a device editor's rendered result for those split
graphemes.

`sendKeys` is the text-input tool. Its `type` command enters text, while `key`
and `clear` commands send keys and clear the focused field, respectively.

<details class="note" markdown="1">
<summary>Pinch rotation semantics</summary>

<code>pinchOn.rotationDegrees</code> describes how far the two-finger axis rotates
during the pinch. The fingers start horizontally and finish on the rotated
axis, so a non-zero value combines pinch and rotation. The default <code>0</code> is
a plain pinch. Android and iOS share this convention.

</details>

## Apps, files & app data

| Tool                                                                                             | What it does                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📱 <code>listApps</code>                                                                         | Lists installed apps with optional label/launchability when reported (`device`, `type`, `search`, `profile`; default `type=launchable`).                        |
| 🚀 <code>launchApp</code>                                                                        | Launches an app by package name; on Android an app already in the foreground is a success flagged `alreadyForeground`.                                          |
| ❌ <code>terminateApp</code>                                                                     | Terminates an app by package name.                                                                                                                              |
| 💥 <code>crashApp</code>                                                                         | Intentionally crashes a running app through the platform crash path.                                                                                            |
| 📦 <code>installApp</code>                                                                       | Installs an APK, app bundle, or IPA.                                                                                                                            |
| 🗑️ <code>uninstallApp</code>                                                                     | Uninstalls an app by package name or bundle identifier.                                                                                                         |
| 🔗 <code>getDeepLinks</code>                                                                     | Queries an app's deep links.                                                                                                                                    |
| 📄 <code>putAppFile</code>                                                                       | Writes local-file, UTF-8, or base64 content into an app container.                                                                                              |
| 🧾 <code>resetAppLogs</code>                                                                     | Resets explicitly named app-container log files and their rotated siblings on the session device, with per-path outcomes.                                       |
| 📥 <code>stageSharedStorage</code>                                                               | Stages host-file, UTF-8, or base64 fixtures into a bounded Android Downloads namespace for system pickers (Android only).                                       |
| 📁 <code>stageSessionDownloads</code>                                                            | Stages fixtures into one bounded child directory of the session device's shared Downloads tree, with optional reset and per-file media indexing (Android only). |
| ⚙️ <code>getPreference</code> / ⚙️ <code>setPreference</code>                                    | Reads or writes Android system properties, SharedPreferences, or iOS UserDefaults.                                                                              |
| 🔑 <code>setKeyValue</code> / 🔑 <code>removeKeyValue</code> / 🔑 <code>clearKeyValueFile</code> | Manages an app key-value storage file.                                                                                                                          |
| 🗃️ <code>listDataStores</code> / 🗃️ <code>getDataStore</code>                                    | Lists or reads Android Jetpack DataStore entries with the SDK adapter.                                                                                          |
| 🗄️ <code>sqlQuery</code>                                                                         | Executes SQL against an app SQLite database.                                                                                                                    |
| 🔐 <code>resetKeychain</code>                                                                    | Resets all Keychain data on an iOS Simulator after explicit confirmation; unsupported on Android and physical iOS devices.                                      |

<details class="note" markdown="1">
<summary>Intentional crash contract</summary>

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

</details>

<details class="example" markdown="1">
<summary>Copy a fixture into an app container</summary>

```json
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
```

</details>

<details class="note" markdown="1">
<summary>File containers</summary>

Android <code>externalFiles</code> maps to <code>/sdcard/Android/data/{appId}/files</code>.
Private containers (<code>documents</code>, <code>cache</code>, and <code>tmp</code>) use
<code>run-as</code> and require a debuggable app. iOS simulator containers include
<code>documents</code>, <code>library</code>, <code>cache</code>, and <code>tmp</code>.

</details>

## Devices & system state

| Tool                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📋 <code>listDevices</code>                                                    | Lists booted devices using the shared device description: identity, runtime, form factor, lifecycle, and session summary; a note points to MCP resources for image detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🖼️ <code>listDeviceImages</code>                                               | Lists configured images using the same canonical identity, runtime, display, lifecycle, provenance, and capability inventory shape as the images resource.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🤖 <code>getAndroid</code> / 🍎 <code>getApple</code>                          | Finds or recovers an Android AVD or iOS Simulator for automation; Android identity includes API level and OS version when known.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 🧱 <code>provisionDevice</code>                                                | Provisions an exact virtual-device identity, with optional resource configuration before automation readiness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ⚙️ <code>setDeviceResources</code>                                             | Configures selected device resources and returns verified, unsupported, or unknown state; omitted settings stay unchanged. Omitted from discovery by default: select it with `setToolEnabled` (case-sensitive `setDeviceResources`) or `--enable-tool setDeviceResources`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🔧 <code>setActiveDevice</code>                                                | Sets the active device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ❌ <code>killDevice</code> / 🧹 <code>deleteDevice</code>                      | Stops a device, or stops and permanently deletes it. Both accept `force: true`, which drops every AVD-name comparison for a wedged Android emulator — the emulator-console confirmation and the platform kill's own re-discovery check — and acts on whatever occupies the serial; it does not bypass serial selection, nor the refusals raised when the pooled entry was retired and replaced mid-action, or when no booted target can be identified at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 📸 <code>deviceSnapshot</code>                                                 | Captures or restores a device snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔄 <code>rotate</code>                                                         | Changes device orientation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 📖 <code>setPosture</code>                                                     | Sets an Android device posture or the iPhone Duo simulator hinge posture (closed, half_opened, opened). The Resizable Android emulator also accepts a phone, unfolded, or tablet display preset. Physical iOS and non-foldable iOS simulators return unsupported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🌐 <code>openLink</code>                                                       | Opens web URLs or routes app and universal deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 🧰 <code>homeScreen</code> / <code>recentApps</code> / <code>systemTray</code> | Controls core system surfaces and notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 🔓 <code>wakeAndUnlock</code>                                                  | Wakes and unlocks the keyguard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🌍 <code>changeLocalization</code>                                             | Changes locale, time zone, text direction, time format, and calendar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ⚙️ <code>getDeviceState</code> / ⚙️ <code>setDeviceState</code>                | Reads or changes Do Not Disturb, simulator biometric enrollment, and network condition. `getDeviceState` also reads back the Android connectivity toggles — `airplaneMode`, `wifiEnabled`, `bluetoothEnabled`, `locationEnabled` — in a single adb round-trip, so a toggle can be checked before it is flipped; a bare call returns `doNotDisturb` + `connectivity`, and `include` selects any subset. A connectivity field is `true`/`false`, or omitted when the device could not answer it (key absent on this API level, or an unparsable value) — omitted never means off. Connectivity is unsupported on iOS: Airplane mode, Wi-Fi, Bluetooth and Location have no simctl/devicectl read verb, and a simulator shares the host's network stack. Degraded profiles — including `offline` — are best-effort cellular shaping on an Android emulator (`adb emu network …`/`gsm data off` plus a best-effort Wi-Fi disable), reported `partial`: they may not affect Wi-Fi or app traffic. Only reset to `none` is fully verified. A session restores the network to a clean `none` state on release. Unsupported on physical Android and all iOS. |
| 🔠 <code>displayConfig</code>                                                  | Reads or sets font/text scale, effective display density, and light/dark theme for adaptive-layout and large-font accessibility testing. Android supports all three fields (density overrides are best-effort on physical devices); the iOS Simulator supports theme only, via `simctl ui appearance`; physical iOS is unsupported. Omitted from discovery by default — select it with `setToolEnabled` (case-sensitive `displayConfig`) or `--enable-tool displayConfig`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🧬 <code>getIosSimulatorCapabilities</code>                                    | Discovers biometrics for a selected iOS Simulator device type and runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🫆 <code>biometricAuth</code>                                                  | Simulates biometric authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 📳 <code>shake</code>                                                          | Shakes an Android emulator or iOS Simulator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 📞 <code>phoneCall</code> / 💬 <code>sendSms</code>                            | Simulates an Android emulator phone call or incoming SMS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 🔔 <code>postNotification</code>                                               | Posts a notification through Android SDK hooks or iOS Simulator push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🔔 <code>getNotificationPolicy</code> / 🔔 <code>setNotificationPolicy</code>  | Reads or changes app notification and Do Not Disturb policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 🛂 <code>getAppPermissions</code> / 🛂 <code>setAppPermissions</code>          | Reads or changes app permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

During canonical-shape phase 1, every device surface returns the complete shared description:
static facts are top-level, changing state is under `runtime`, and the previous nested and flat
aliases remain present as compatibility fields.

### Keeping an Android orientation locked

`rotate` preserves its existing behavior when `lockOrientation` is omitted: it
temporarily disables auto-rotate when necessary, then restores the prior
setting. To keep portrait or landscape orientation in effect for subsequent
actions, pass `lockOrientation: true`:

```json
{ "orientation": "landscape", "lockOrientation": true }
```

The result reports `orientationLockState` as `locked`, `unlocked`, or `unknown`.
A persistent request succeeds only after live rotation and the lock are
confirmed. If lock verification fails, `currentOrientation` reports the latest
confirmed live orientation, or `unknown` when it cannot be read.

To restore automatic rotation, pass `lockOrientation: false`, for example
`{ "orientation": "landscape", "lockOrientation": false }`. These lock options
are supported only on Android.

### Acquiring a device: `avdName`, `udid`, and the `deviceId` alias

`startDevice`, `getAndroid`, and `listDevices` accept `requires: { panels?: number; posture?:
Posture }`. `panels` is a minimum; `posture` must appear in the device's supported
postures. A `foldable` form factor alone does not imply two panels: some foldable
AVDs only change posture on one panel. Booted devices use their display inventory.
`listDevices` filters its booted results. For an unbooted AVD without known display profile metadata, panel and posture
support is unknown until booted, so capability matching will not select it.
When no device qualifies, acquisition reports the requested capabilities and
the candidates' known support.

`getAndroid` and `getApple` each accept two ways to name a target; pass one.

- **`getAndroid`** — `avdName` names a configured Android Virtual Device (the
  `name` field of `automobile:devices/images/android`). It is the identity
  AutoMobile uses to boot and coordinate a named AVD: the `avdName` path passes
  `matchExactName`, `androidAvdName`, and a `stableTarget` for exact AVD-identity
  and lifecycle coordination. `deviceId` is the copy-paste-from-discovery
  convenience: it accepts either an _already-booted_ serial such as
  `emulator-5554` (the `runtime.deviceId` field of `automobile:devices/booted/android`)
  **or** an AVD image name — if it names a defined-but-unbooted AVD, `getAndroid`
  cold-boots that image by name. The difference is the coordination hints the
  `avdName` path passes up front — `matchExactName`, an `androidAvdName`
  startup-lease hint, and an eager `stableTarget` — so prefer `avdName` when you
  specifically want to boot or coordinate a named AVD; use `deviceId` to attach
  to a running device or to boot straight from a discovered identifier.
- **`getApple`** — `udid` is the iOS Simulator UDID. `deviceId` is an accepted
  **alias** for `udid`: a booted simulator's `runtime.deviceId` (from
  `automobile:devices/booted/ios`) _is_ its `udid`, so both fields resolve to the
  same value.

The `deviceId` fields exist so the value at `runtime.deviceId` in `listDevices` and the
`automobile:devices/booted/*` resources can be copied straight into
`getAndroid`/`getApple` — the discovery→acquire path (#5870). See the
[FAQ](faq.md#how-do-i-see-or-start-a-device) for the CLI equivalents.

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

On Android, `videoRecording({ action: "start", display })` accepts a physical
panel key, the role `inner`, `cover`, `rear`, or `external`, or `"active"`.
Omitting `display` selects the active panel when supported. Multi-panel recordings pin
`screenrecord` to that physical panel for the full capture; a panel switch
does not retarget it. The stop result's `metadata.recordedPanel` gives its
`key` and `role`, and `metadata.transitions` contains timestamped
`{ atMs, from, to }` panel changes in milliseconds since capture start. For
segmented recordings, `atMs` includes preceding segments' time offsets and
each segment may begin with a boundary transition when the active panel
differs from the recorded panel (`atMs: 0` for the first segment, or the
segment offset for later segments).
If no multi-panel inventory is available, Android keeps the existing
`screenrecord` command and omits `recordedPanel`.
A one-panel inventory reports that panel without changing the command. On a
known API below 34, default multi-panel recording uses the flagless command
and returns a warning; explicit panel selection requires API 34 or newer.
When the API is unknown and `screenrecord` quickly rejects `--display-id`,
capture retries once without the flag and returns a warning. iOS does not
accept the recording `display` argument.

## Accessibility & session tools

| Tool                               | What it does                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ♿ <code>accessibility</code>      | Reads or controls Android TalkBack and iOS VoiceOver, returning fresh device state.                                                                                                                                                                                                                                |
| 🎯 <code>accessibilityFocus</code> | Sets or clears Android TalkBack focus by resource ID, text, or content description.                                                                                                                                                                                                                                |
| 🔀 <code>setToolEnabled</code>     | Controls which AutoMobile tools appear in `tools/list` for the current MCP session; an omitted tool remains callable directly by name through `tools/call` — one exact name via `toolName`, or a batch via `toolNames`; unknown or hidden names reject the batch, while always-on names are returned in `skipped`. |

Before acquiring a device, read `automobile:tools` for every tool's default discovery state. Startup enable/disable settings also affect discovery only, not direct `tools/call` by name.

On Android and iOS, compact observations fold soft-keyboard keys into a single
`keyboard: { visible: true, package: "…" }` summary plus at most one skeleton row:

```
<ime> | Keyboard (com.google.android.inputmethod.latin) | input
```

On iOS, the row is labelled `Keyboard (com.apple.keyboard)`.

That row appears only when the IME exposed at least one bounded accessible
descendant. A keyboard whose window carries no accessible keys — some IMEs
expose none — is still announced by the `keyboard` summary, with no `<ime>` row,
because a synthetic row must never claim a box it cannot measure. Treat the
summary as the presence signal and the row as optional.

`<ime>` is a marker, not a selector — use `sendKeys` for text input and semantic
keys, or `keyboard` to open or close it. Everything the IME itself owns folds
into that row, including its toolbar, emoji and clipboard affordances — Gboard
gives those the same `key_pos_*` ids it gives letter keys
(`key_pos_header_access_points_menu`, `key_pos_switch_to_symbol`), and many keys
carry no resource-id at all, so nothing distinguishes them from a keycap. What
stays individually actionable is framework chrome sharing the window: a control
whose resource-id belongs to a DIFFERENT package than the IME, such as
`android:id/input_method_nav_back`. `observe` with `project: "full"` or `raw: true` retains
the individual keys. Keys are identified from the IME window identity a re-cut
control proxy supplies, and otherwise from the `…:id/key_pos_*` keycap
resource-id family, so the fold also applies on older proxy builds and on the
`uiautomator dump` path. An absent summary means no IME identity was captured,
not a confirmed hidden keyboard.

A skeleton row omits `label` entirely when it has none — the key is never
present with a placeholder value. A state-carrying container with no text of its
own (the `switchWidget` of a Settings row, a scrollable fragment root) takes the
label of its nearest labelled enclosing row, so a `checked` state is attributable
to the setting it belongs to (`com.android.settings:id/switchWidget | Airplane
mode | toggle checked=false`).

Action-observation diffs under the default skeleton projection use those same
compact row fields for `added` and `removed` nodes; rows with no affordances are
omitted. Their `fields.layoutWarnings` value is an `{ added, removed }` pair
rather than a whole `{ from, to }` envelope, and excludes Android system-status
bar notification chrome. An artifact-spilled diff keeps its `skeleton`,
`context`, and capture metadata inline while the bulky node and field deltas are
available from its artifact pointer.

`observe` can wait for a display stamp with `waitFor: { posture: "closed" }` or
`waitFor: { activeDisplay: "cover" }`. `activeDisplay` accepts either a physical
panel key or a role. These conditions compare the returned observation's
`display` stamp. Posture waits accept only known postures; `unknown` remains a
possible observation stamp but cannot be requested as a wait condition. Posture
waits need a device that reports posture; Android observations currently report
`unknown` posture.
An action-observation diff includes `displayChanged: { from, to }` when the
panel key, role, or posture changes. Capture generation alone does not create a
display change entry.

For the observe → act → observe behavior behind interaction tools, see the
[interaction loop](design-docs/mcp/interaction-loop.md). For per-session public
tool selection, see [Dynamic Tools](using/dynamic-tools.md).
