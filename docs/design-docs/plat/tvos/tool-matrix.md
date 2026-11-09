# tvOS tool support matrix

Support for every MCP tool in `schemas/tool-definitions.json` when the target is
an Apple TV simulator. Results were measured against an Apple TV 4K (3rd
generation) simulator on tvOS 26.5 and tvOS 27.0, using a probe app with a text
field and a 3×3 button grid.

## How the gate works

Device-aware tools accept a tvOS device only when they are listed in
`APPLE_PLATFORM_SUPPORTED_TOOLS.tvos` (`src/server/applePlatformToolSupport.ts`).
Every other device-aware tool fails closed before its handler runs: a request
that names `platform: "tvos"` is refused before target resolution, and a
resolved Apple TV device is refused at dispatch. Device-management tools that
look up their own target (`killDevice` and similar) refuse a `tvos` request by
name unless they are allowlisted. Refusals carry a generic "does not support
tvOS yet" message, a "not available on tvOS" message naming the missing runtime
capability (`displayConfig`, `statusBar`, `clipboard`, `getAppPermissions`), or a
focus-navigation hint for touch gestures (`tapAt`, `swipeOn`, `pinchOn`,
`multiTouch`, `dragAndDrop`, `tapAny`).

## Observe text policy

The single `@MainActor` router owns a `TVKeyboardSettleGate` for hierarchy requests,
using an injected uptime clock. Its only mutable state is `lastKeyboardSeen`.
A type-19 keyboard node anywhere in a snapshot updates that timestamp and
withholds every text-input value (types 45, 49, 50 and 52), regardless of focus
or position in the tree. Withholding continues across snapshots without a
keyboard until at least `settleWindow = 1.0` seconds have elapsed since the last
keyboard snapshot and the current snapshot contains neither a keyboard nor an
anonymous type-45, type-49 or type-52 input. Anonymous means identifier, label
and placeholder are all empty after trimming whitespace and newlines; a nil
placeholder is empty. Only then is the timestamp cleared. Backward or non-finite
clock readings fail closed; a non-finite stored timestamp also prevents release
until a keyboard snapshot supplies a finite timestamp.

Nodes retain their snapshot identifier, class and focus; withheld field nodes
emit only their labels, and placeholders appear only as keyboard prompt nodes.
As a second guard, anonymous type-52 nodes never emit values, even with no gate
state. After the gate releases, a named plain field's value is readable through
`observe` on its own node, joined with its label when distinct. Whitespace-only
values and values equal to the placeholder count as empty; a whitespace-only
label counts as empty when joining. Secure fields, including type-50 nodes and
fields identified by secure metadata, always redact their values.

## Status values

- **pass**: allowlisted and verified working on an Apple TV simulator.
- **refused-by-design**: fails closed because the capability does not exist on
  tvOS (no touch surface, orientation, telephony or keyguard; the tvOS simulator
  runtime lacks the simctl service; or the tool is Android-, Wear OS- or
  watchOS-only).
- **not-supported**: fails closed today although tvOS could support it. The
  linked issue tracks enabling it; tools with no linked issue have none filed.
- **host-only**: does not target a device, so the tvOS gate does not apply.

## Matrix

| Tool                          | Status            | Notes                                                                                                                                            |
| ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accessibility`               | not-supported     | Needs runner work.                                                                                                                               |
| `accessibilityAction`         | refused-by-design | Android-only (TalkBack and Switch Access actions).                                                                                               |
| `accessibilityAudit`          | not-supported     | Needs runner work.                                                                                                                               |
| `accessibilityFocus`          | not-supported     | Needs runner work.                                                                                                                               |
| `ambient`                     | refused-by-design | Wear OS only.                                                                                                                                    |
| `appLifecycle`                | not-supported     |                                                                                                                                                  |
| `audit`                       | not-supported     | Deprecated alias of `accessibilityAudit` and `performanceAudit`.                                                                                 |
| `backgroundWork`              | refused-by-design | Android-only.                                                                                                                                    |
| `barrier`                     | not-supported     | Plan-only multi-device primitive.                                                                                                                |
| `biometricAuth`               | refused-by-design | Apple TV has no biometric sensor.                                                                                                                |
| `captureAudio`                | not-supported     |                                                                                                                                                  |
| `captureTrace`                | not-supported     | Needs runner work.                                                                                                                               |
| `changeLocalization`          | not-supported     |                                                                                                                                                  |
| `clearKeyValueFile`           | not-supported     |                                                                                                                                                  |
| `clearMockNetwork`            | not-supported     |                                                                                                                                                  |
| `clipboard`                   | refused-by-design | The tvOS simulator runtime has no pasteboard service; the refusal says so.                                                                       |
| `compareScreenshot`           | pass              | Record and compare via `simctl io` screenshots.                                                                                                  |
| `crashApp`                    | not-supported     | [#16723].                                                                                                                                        |
| `criticalSection`             | not-supported     | Plan-only multi-device primitive.                                                                                                                |
| `deleteDevice`                | pass              | Destroy with verified inventory absence.                                                                                                         |
| `deleteKeychainItem`          | not-supported     |                                                                                                                                                  |
| `deviceSnapshot`              | not-supported     |                                                                                                                                                  |
| `displayConfig`               | refused-by-design | The tvOS simulator runtime has no appearance or content-size service; the refusal says so.                                                       |
| `displayProfile`              | refused-by-design | Android-only.                                                                                                                                    |
| `dragAndDrop`                 | refused-by-design | No touch surface.                                                                                                                                |
| `dragPath`                    | refused-by-design | No touch surface.                                                                                                                                |
| `executePlan`                 | pass              |                                                                                                                                                  |
| `explore`                     | pass              | Moves focus and selects. Only works when the embedded-SDK tool set is enabled; otherwise the call fails with `Unknown tool: explore` ([#17528]). |
| `exportPlan`                  | host-only         |                                                                                                                                                  |
| `focusNavigate`               | pass              |                                                                                                                                                  |
| `getAndroid`                  | host-only         | Android AVD discovery.                                                                                                                           |
| `getApple`                    | host-only         | iOS Simulator discovery.                                                                                                                         |
| `getAppPermissions`           | refused-by-design | simctl has no permission read verb; the refusal says so. `setAppPermissions` covers the write side.                                              |
| `getDataStore`                | refused-by-design | Android-only (Jetpack DataStore).                                                                                                                |
| `getDeepLinks`                | pass              |                                                                                                                                                  |
| `getDeviceState`              | not-supported     |                                                                                                                                                  |
| `getIosSimulatorCapabilities` | host-only         |                                                                                                                                                  |
| `getLogs`                     | not-supported     | `simctl spawn log show` works on tvOS; [#16723].                                                                                                 |
| `getNavigationGraph`          | not-supported     |                                                                                                                                                  |
| `getNetworkGraph`             | not-supported     |                                                                                                                                                  |
| `getNotificationPolicy`       | not-supported     |                                                                                                                                                  |
| `getPreference`               | not-supported     |                                                                                                                                                  |
| `heapDump`                    | refused-by-design | Android-only.                                                                                                                                    |
| `highlight`                   | not-supported     |                                                                                                                                                  |
| `hitTest`                     | refused-by-design | No touch surface.                                                                                                                                |
| `homeScreen`                  | pass              | Presses the Siri Remote `home` button (same press as `pressButton home`); the result reports the press, not a checked home screen.               |
| `hoverAt`                     | refused-by-design | No stylus or pointer.                                                                                                                            |
| `identifyInteractions`        | not-supported     | Also behind the debug flag.                                                                                                                      |
| `injectAudioInput`            | not-supported     |                                                                                                                                                  |
| `inspectPackageSigning`       | not-supported     |                                                                                                                                                  |
| `installApp`                  | pass              |                                                                                                                                                  |
| `keyboard`                    | not-supported     |                                                                                                                                                  |
| `killDevice`                  | pass              |                                                                                                                                                  |
| `killProfile`                 | refused-by-design | Android-only.                                                                                                                                    |
| `launchApp`                   | pass              |                                                                                                                                                  |
| `listApps`                    | pass              |                                                                                                                                                  |
| `listDataStores`              | refused-by-design | Android-only (Jetpack DataStore).                                                                                                                |
| `listDeviceImages`            | pass              |                                                                                                                                                  |
| `listDevices`                 | pass              | Filters with `platform: "tvos"`.                                                                                                                 |
| `manufacturerProfile`         | refused-by-design | Android-only.                                                                                                                                    |
| `measureStartup`              | refused-by-design | Android-only.                                                                                                                                    |
| `mediaSession`                | refused-by-design | Android-only.                                                                                                                                    |
| `mockNetwork`                 | not-supported     |                                                                                                                                                  |
| `multiTouch`                  | refused-by-design | No touch surface.                                                                                                                                |
| `navigateTo`                  | not-supported     |                                                                                                                                                  |
| `network`                     | not-supported     |                                                                                                                                                  |
| `observe`                     | pass              | Reports `focusedElement`. Typed values are withheld while the keyboard is open; see the observe text policy.                                     |
| `openLink`                    | pass              | Opens declared app schemes. A web URL or an undeclared scheme fails with the documented error.                                                   |
| `performanceAudit`            | not-supported     | Needs runner work.                                                                                                                               |
| `performanceTrace`            | not-supported     | Needs runner work.                                                                                                                               |
| `phoneCall`                   | refused-by-design | No telephony.                                                                                                                                    |
| `pinchOn`                     | refused-by-design | No touch surface.                                                                                                                                |
| `portReverse`                 | refused-by-design | Android-only.                                                                                                                                    |
| `postNotification`            | pass              | `simctl push` to the app named by `appId` (required).                                                                                            |
| `pressButton`                 | pass              | `up`, `down`, `left`, `right`, `select`, `menu`, `home`, `playPause`. Long press and `steps` are not supported ([#16726]).                       |
| `prototype`                   | not-supported     |                                                                                                                                                  |
| `provisionDevice`             | pass              | Boots with readiness `none`.                                                                                                                     |
| `putAppFile`                  | not-supported     |                                                                                                                                                  |
| `recentApps`                  | not-supported     |                                                                                                                                                  |
| `reconcileDeviceResources`    | not-supported     |                                                                                                                                                  |
| `recordDeviceGestures`        | not-supported     |                                                                                                                                                  |
| `recordToolCalls`             | host-only         |                                                                                                                                                  |
| `removeKeyValue`              | not-supported     |                                                                                                                                                  |
| `resetAppLogs`                | not-supported     |                                                                                                                                                  |
| `resetKeychain`               | not-supported     |                                                                                                                                                  |
| `rotaryScroll`                | refused-by-design | Wear OS only.                                                                                                                                    |
| `rotate`                      | refused-by-design | No orientation.                                                                                                                                  |
| `rotateCrown`                 | refused-by-design | watchOS only.                                                                                                                                    |
| `selectAllText`               | not-supported     |                                                                                                                                                  |
| `sendBroadcast`               | refused-by-design | Android-only.                                                                                                                                    |
| `sendKeys`                    | pass              | Requires a focused keyboard (`pressButton select` on the field); otherwise `no focused text input`. Read plain values after close.               |
| `sendSms`                     | refused-by-design | No telephony.                                                                                                                                    |
| `setActiveDevice`             | pass              |                                                                                                                                                  |
| `setAppLinks`                 | refused-by-design | Android-only.                                                                                                                                    |
| `setAppPermissions`           | pass              | `simctl privacy` grant, revoke or reset; changes are not read back (`verified: false`).                                                          |
| `setDeviceResources`          | not-supported     |                                                                                                                                                  |
| `setDeviceState`              | not-supported     |                                                                                                                                                  |
| `setKeyValue`                 | not-supported     |                                                                                                                                                  |
| `setNotificationPolicy`       | not-supported     |                                                                                                                                                  |
| `setPosture`                  | refused-by-design | No foldable posture.                                                                                                                             |
| `setPreference`               | not-supported     |                                                                                                                                                  |
| `setSensor`                   | refused-by-design | Android-only.                                                                                                                                    |
| `setToolEnabled`              | host-only         |                                                                                                                                                  |
| `setUIState`                  | not-supported     | Also behind the debug flag.                                                                                                                      |
| `shake`                       | refused-by-design | No motion gesture.                                                                                                                               |
| `siri`                        | not-supported     |                                                                                                                                                  |
| `snapshotOf`                  | not-supported     |                                                                                                                                                  |
| `sqlQuery`                    | not-supported     |                                                                                                                                                  |
| `statusBar`                   | refused-by-design | The tvOS simulator runtime has no status bar override; the refusal says so.                                                                      |
| `stopAudioInput`              | not-supported     |                                                                                                                                                  |
| `swipeAt`                     | refused-by-design | No touch surface. Siri Remote touch-surface swipes are [#16726].                                                                                 |
| `swipeOn`                     | refused-by-design | No touch surface. Siri Remote touch-surface swipes are [#16726].                                                                                 |
| `systemAlerts`                | not-supported     |                                                                                                                                                  |
| `systemTray`                  | refused-by-design | No notification shade.                                                                                                                           |
| `tapAny`                      | refused-by-design | No touch surface; use `tapOn` or `focusNavigate`.                                                                                                |
| `tapAt`                       | refused-by-design | No touch surface.                                                                                                                                |
| `tapOn`                       | pass              | Moves focus to the element by text or `elementId` and selects it.                                                                                |
| `terminateApp`                | pass              |                                                                                                                                                  |
| `uninstallApp`                | pass              |                                                                                                                                                  |
| `videoRecording`              | pass              | `simctl io recordVideo`, HEVC MP4.                                                                                                               |
| `wakeAndUnlock`               | refused-by-design | No keyguard.                                                                                                                                     |
| `windowMode`                  | refused-by-design | Android-only.                                                                                                                                    |

Totals: 25 pass, 51 not-supported, 40 refused-by-design, 6 host-only. The tvOS
allowlist also holds `startDevice`, which is not in the published tool
definitions; it boots the simulator and connects the runner.

[#16723]: https://github.com/kaeawc/auto-mobile/issues/16723
[#16726]: https://github.com/kaeawc/auto-mobile/issues/16726
[#17528]: https://github.com/kaeawc/auto-mobile/issues/17528
