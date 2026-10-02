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
simulator panel can be observed.

`tapOn`, `tapAt`, `swipeOn`, `pinchOn`, `dragAndDrop`, and `sendKeys` accept the
same optional `display` selector. First observe the target panel, then pass the
same panel to the action. An explicit action rejects coordinates from another
panel and asks you to re-observe the target. A display-transition refusal carries
`staleDisplay: { observedGeneration, currentGeneration, currentDisplayKey?, retry: "observe" }`
on the failure result (and in MCP `structuredContent`), with the same generations
and re-observe instruction in `error`. Android single-finger input uses
the selected panel's logical display ID. The current Android CtrlProxy APK does
not expose per-display two-finger gesture dispatch, so `pinchOn` on an explicitly
selected Android panel reports that limitation. iOS accepts only its live panel.
On iOS, `tapOn`, `swipeOn`, `dragAndDrop`, and `pinchOn` validate the selected
panel, then use their existing CtrlProxy gesture path on that live panel.
For Android `sendKeys`, text, clear, and IME actions require a selector when
`display` is set so the input field can be focused on that panel. Discrete key
events use `input -d` directly.

### Screen-coordinate contract

`snapshotOf` is an opt-in tool. Enable it with `setToolEnabled`, then pass
either `elementId` for one uniquely exposed element or `rectangle` with
`left`, `top`, `right`, and `bottom` in the platform-native screen units below.
It captures one screen PNG, clips the rectangle to visible bounds, and saves a
full-resolution PNG crop. The response contains the file path, requested and
clipped bounds, screen and image sizes, effective pixels per native unit, scale
provenance, screenshot orientation, and clipping status. It does not return image
bytes. Missing or ambiguous IDs and empty or off-screen rectangles are errors.

`observe` reports platform-native, current-orientation screen coordinates. The
origin is the top-left of the complete current screen, including system UI:

- Android uses physical pixels; iOS uses XCTest logical points.
- `screenSize`, skeleton bounds, full-hierarchy bounds, and absolute `tapAt`
  input use that same platform-native coordinate space. An embedded action
  observation carries the same `screenSize` in full, skeleton, and diff output.
- Valid coordinates are half-open: `0 <= x < width` and `0 <= y < height`.
- A point already in the platform-native space is not density-, inset-,
  Retina-scale-, canonical-pixel-, or rotation-transformed.

`tapAt({ x, y })` performs one tap in those native units. Set
`coordinateSpace: "normalized"` for values from 0 to 1, or `"percent"` for
values from 0 to 100. Both axes resolve against the same observed `screenSize`;
the right and bottom endpoints resolve to the last in-bounds native point.
Values outside those ranges and non-finite values are rejected. The result
includes the resolved native `x` and `y`.

Set `action: "longPress"` or `"doubleTap"` for another coordinate gesture.
Long press defaults to 1000 ms and accepts `durationMs` from 500 to 10000;
`durationMs` is valid only for long press. Double tap uses two native taps
200 ms apart. The result includes `action`. All variants accept `display`.

`tapAt`, `tapOn`, `tapAny`, `swipeOn`, `dragAndDrop`, and `pinchOn` fence
coordinates when the display transitions after the caller's observation or while
the action is preparing or dispatching. These failures include `staleDisplay`
with the observed and current identity generations and `retry: "observe"`.
Observe again and choose the target from the new panel before retrying. A caller
without a prior observation skips the entry fence; in-flight transitions still
reject stale work.

This is separate from the daemon observation-stream's
[canonical-pixel mapping](design-docs/mcp/daemon/screen-control-mapping.md).
That stream contract is intentional and does not transform MCP `observe` or
native absolute-input coordinates.

`observe`, `observe.screenSize`, and `tapAt` use the device's current-orientation
native coordinate space described above. For a fresh screenshot matching an
observation, call `observe({ screenshot: "settled" })` and read its
`screenshotPath`.
For encoded captures, pass `screenshotOptions` with `screenshot: "settled"` or
`includeScreenshotImage: true`,
for example `observe({ screenshot: "settled", screenshotOptions: { format: "webp", quality: 80 } })`.
Omitting options requests PNG. JPEG and WebP accept integer `quality` from 1 to 100. WebP also accepts `lossless: true`, which cannot be combined with
`quality`; PNG accepts neither. The returned `screenshotFormat`,
`screenshotMimeType`, and `screenshotPath` extension describe the saved bytes
after a platform capture fallback. The path does not depend on reading an
in-protocol screenshot resource. The screenshot's orientation follows the device framebuffer:
on the iOS Simulator, the framebuffer can remain portrait after `rotate`, even
while the device orientation is landscape (this is simulator framebuffer
behavior, not an AutoMobile bug); on Android, the raster rotates with the
device. Therefore, after rotation, callers must apply a platform- and orientation-specific
transform before correlating iOS `observe` or `tapAt` coordinates with
`observe` screenshot pixels. No such transform is needed on Android. The
`screenshotOrientation` field identifies the returned raster orientation.

When `observe` has verifiable geometry and a frame context, it returns
`snapshotReference: { snapshotId, expiresAt }`. Pass `snapshotId` with native
screen coordinates to `tapAt` to bind the tap to that observation. References
are process-local and expire within five minutes. A tap rejects a reference after
device restart or reassignment, runner restart, or a change to the display panel,
role, posture, rotation, screen size, native scale, or app id. Android also
compares a known activity name, window type, and focused window identity and
bounds when both observations provide them. iOS does not provide Android
activity names; its available app-window metadata (when present) describes the
application window and does not detect in-app navigation. A display revision or
runner frame-event counter advancing by itself does not invalidate the reference.
A rejected tap does not silently recapture or retarget.
When a session `observe` cannot produce a reference, it returns
`snapshotReferenceUnavailable`, a `string[]` naming the missing capture
preconditions: `display`, `screenSize`, `rotation`, `nativeScale`, `frameContext`
(in that order). This field is absent when a reference is returned and on
`deviceId` reads, which never return a reference. On iOS, a simulator/device whose
orientation is unknown reports `rotation` as missing because the runner omits
`rotation` when device orientation is unknown or unstable.

This reference covers the full screen; it does not convert screenshot pixels
into native coordinates or account for a crop. Unchanged geometry and window
context do not prove unchanged visual content — re-observe after UI changes.
The comparison deliberately does not detect scrolling, in-layout sheets,
single-activity navigation, or WebView page changes.

`hitTest` previews the same `{"x":120,"y":240}` native screen target accepted
by `tapAt`, including its optional `display` selector. It is opt-in. Its
`point`, `screenSize`, and `reference` report the resolved screen geometry;
`firstCandidate` is `null` when no accessible bounds contain the point.
`candidates` contains at most 25 hierarchy nodes, ordered by reported window
layer, then interactive status, smaller containing bounds, and depth. The
response always says `"method":"hierarchy-bounds"` and
`"dispatchGuaranteed":false`. It sends no input. Gesture interception,
transformed hit regions, custom drawing inside a canvas, and screen-reader
behavior can all make the actual native event recipient differ from this
estimate. Re-observe after navigation, scrolling, or animation before using the
point with `tapAt`.

### Screenshot delivery to local and remote clients

For a local client with access to the AutoMobile host filesystem, `observe` returns
the screenshot path in its structured observation. This remains the default: omitting
`includeScreenshotImage` or setting it to `false` never reads or embeds image bytes.
Use `screenshot: "settled"` when the path must correspond to the completed observation.

For a remote client that cannot read that path, call
`observe({ screenshot: "settled", includeScreenshotImage: true })`. The tool keeps
the structured observation and its path, and adds an MCP image content block with
the exact captured bytes and the observation's reported MIME type when available
(otherwise detected from bytes or file extension). Setting `includeScreenshotImage:
true` alone also selects settled capture. It cannot be combined with explicit
`screenshot: "async"` or `"none"`.

Inline delivery supports PNG, JPEG, and WebP, with a 5 MiB file limit. The
structured result includes `screenshotImage: { included: true, mimeType, sizeBytes }`
when delivery succeeds. If the path is missing, the image exceeds the limit,
its format is unsupported, or reading fails, the observation still returns with
`screenshotImage: { included: false, reason, sizeBytes?, capBytes? }` and its
usual screenshot path when available. Use that path (local clients) or the
observation screenshot resource (remote clients) for the completed capture.
Cancellation before or during delivery stops the response. The opt-in can substantially increase MCP
response size, so use it only when the client needs image bytes in the tool result.

| Tool                                 | What it does                                                              |
| ------------------------------------ | ------------------------------------------------------------------------- |
| 👀 <code>observe</code>              | Gets the current screen view hierarchy.                                   |
| 🎯 <code>hitTest</code>              | Estimates hierarchy nodes beneath a coordinate without dispatching input. |
| 🔍 <code>explore</code>              | Explores an app to build a navigation graph.                              |
| 🗺️ <code>navigateTo</code>           | Navigates using the learned navigation graph.                             |
| 📊 <code>getNavigationGraph</code>   | Retrieves the navigation graph for debugging.                             |
| 🔗 <code>identifyInteractions</code> | Suggests likely interactions.                                             |
| 🖍️ <code>highlight</code>            | Draws a visual highlight around a UI element.                             |

### Observe a booted device by ID

`observe {"deviceId":"emulator-5554"}` returns the normal screen observation,
including hierarchy or skeleton, active window, screen size, display, device lock,
and a screenshot path with its fresh or cached label. It does not acquire a
session or change device ownership, and it works while another session owns the
device. An observer read does not update that session's observation baseline,
snapshot references, navigation graph, or observation stream. The read only
connects to an already-running hierarchy service; it never starts, installs,
enables, or restarts one. With `sessionUuid`, the call is a
session observe, and `deviceId` must match that session's device.

- If the owning session's hierarchy client is disconnected, hierarchy freshness
  reports `connection_lost`; `unavailableDetail` and the warning tell the owner
  to run a session observe to reconnect. The read does not create a second client.
- Hierarchy reads wait behind requests tracked by the service client, with a
  deadline. ADB-driven owner actions run independently: an observer may capture
  their intermediate UI but does not cancel or reorder their commands. Android
  ADB screenshots share a capture lock; the observer waits at most 10 seconds
  before reporting a screenshot failure, without cancelling the owner's capture.
- An unowned device with an unreachable service reports an unavailable hierarchy.
  Android can still capture via ADB, and iOS simulators via `simctl`. A physical
  iOS device without a reachable runner has no host-side screenshot path. If no
  cached screenshot is available, `screenshotPath` is absent,
  `screenshotSettled` is false, and `screenshotSettledError` explains why no
  screenshot could be captured. Otherwise a cached screenshot is labelled as such.

Session-less device reads reject `waitFor`, `raw: true`, and `skipBackStack: true`
before hierarchy or screenshot capture. Use a session observe (pass `sessionUuid`)
for waiting; `settled` requires `waitFor` and is covered by that rejection.
Use `project: "full"` for the full filtered hierarchy. Device reads omit
`snapshotReference`.

The default `screenshot: "settled"` awaits a fresh validated capture; it does not
wait for action history to settle. `screenshot: "async"` also awaits capture on
device reads, while `"none"` skips it. If capture fails, an eligible cached
screenshot may be returned with its cached label and capture failure details.

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
| 🔘 <code>pressButton</code>   | Presses a device or navigation button. iOS simulators support volume and power; iOS does not support menu.                     |
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

| Platform / mode                                | Unicode text, including emoji                            | Delivery                                                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS, any requested mode                        | Supported; the requested mode resolves to `xcuiTypeText` | XCUITest `typeText` receives the whole string.                                                                                                        |
| Android `a11y`                                 | Supported                                                | Accessibility `ACTION_SET_TEXT` writes the whole string.                                                                                              |
| Android `ime`, or `auto` when IME is available | Supported                                                | CtrlProxy IME delivers complete graphemes through `InputConnection`; `auto` can fall back as described above.                                         |
| Android `eventAll`                             | Supported; whole graphemes                               | Single printable ASCII characters with a key-event plan use key events; all other graphemes are inserted whole through accessibility.                 |
| Android `eventLast`                            | Supported with split delivery                            | ASCII uses key events; other text uses accessibility insertion. A keycap, decomposed letter, or ASCII followed by ZWJ can split after its ASCII base. |
| Android `eventOnly`, `imeKeyEvents`            | ASCII only                                               | `eventOnly` preflights available key events; `imeKeyEvents` accepts printable ASCII only. Unsupported text fails before editing.                      |

Android `eventAll` sends single printable ASCII characters with a key-event
plan through `adb shell input keyevent` and inserts all other graphemes whole
through accessibility. `eventLast` sends ASCII with key events and sends
unsupported runs through accessibility insertion; it can split a grapheme. They
do not use `adb shell input text`, so shell text escaping does not transform
their Unicode runs. `imeKeyEvents` also rejects all non-printable-ASCII text
during preflight, before any key event is sent.

Use `ime`, `a11y`, `eventAll`, or `auto` for complete grapheme delivery.
`auto` uses the IME when available; its Android insertion fallback uses
`eventAll`. A failed `eventAll` insertion reports the failed grapheme code
points and `committedGraphemes`, the count of complete clusters delivered
before the failed run.
A successful Android `eventAll` command may carry a `warning` if caret placement fails; all remaining text in that command is then inserted whole, using a remembered caret (same node, exact text, and unchanged reported selection, at most 5 seconds). Every insert refreshes the node; a previous insert's text is awaited for up to 300 ms, with a warning if it never matches. Gestures, text commands, focus/window changes, and changed selection reports invalidate the remembered caret.
`eventLast` fails with partial application if its prefix insert cannot place the caret, because its tail requires a real key event. Segment warnings are retained on success and failure.
Before insertion, preceding key-event text is awaited by exact suffix for up to 300 ms; an existing identical suffix can pass early, while IME transformations can time out with a warning.
A lengths-only warning compares the planned UTF-16 length for `replace` when the final delivery is an insert and the APK returns a length; it skips `insert`, subsequent key events, old APKs, and other modes, and cannot detect field-side filtering.
`SendKeysCommandResult.textLength` counts Unicode code points, rather than
graphemes or UTF-16 code units. On iOS, XCUITest `typeText` supplies the text
independently of the active keyboard layout; the UI regression corpus checks
non-Latin strings with the simulator's current keyboard configuration, but does
not switch among keyboard layouts. If simulator typing does not enter text,
check the **Connect Hardware Keyboard** setting.

#### Unicode behavior by `sendKeys` mode

The following describes the current delivery path. `eventAll` classifies whole
graphemes; `eventLast` can still split them.

| Mode                                     | Non-ASCII                                              | Emoji (including surrogate pairs and ZWJ sequences)                                       | Combining marks                                                                | CJK                                                    | Notes                                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS `xcuiTypeText` (all requested modes) | Passed as one string                                   | Passed as one string                                                                      | Passed as one string                                                           | Passed as one string                                   | Uses XCUITest `typeText` through the text client.                                                                                                                               |
| Android `a11y`                           | Passed intact                                          | Passed intact, including surrogate pairs and ZWJ                                          | Passed intact with its base                                                    | Passed intact                                          | Uses accessibility text insertion.                                                                                                                                              |
| Android `ime`                            | Committed intact                                       | Committed as supplied                                                                     | Committed with its base                                                        | Committed intact                                       | Uses the CtrlProxy commit IME; final editor rendering depends on the IME/editor.                                                                                                |
| Android `eventAll`                       | Whole graphemes inserted                               | Whole emoji clusters inserted through accessibility                                       | Inserted with their base                                                       | Inserted intact                                        | Only single printable ASCII characters with a key-event plan use key events. Other clusters, including `é` and `1️⃣`, are inserted whole; adjacent clusters may share an insert. |
| Android `eventLast`                      | Passed intact when no ASCII key-event character occurs | Passed intact when no ASCII key-event character occurs; ASCII neighbors may cause a split | A trailing mark after ASCII `e` is inserted separately after the `e` key event | Passed intact when no ASCII key-event character occurs | Sends the last supported ASCII key event, with preceding and following text inserted through accessibility.                                                                     |
| Android `eventOnly`                      | Rejected before mutation                               | Rejected before mutation                                                                  | Rejected before mutation                                                       | Rejected before mutation                               | Preflights the entire string and fails at the first character without a key-event plan.                                                                                         |
| Android `imeKeyEvents`                   | Rejected before mutation                               | Rejected before mutation                                                                  | Rejected before mutation                                                       | Rejected before mutation                               | Accepts printable ASCII only and preflights before sending key events.                                                                                                          |

`eventAll` segments text into graphemes before choosing key events or
accessibility insertion. Its insertion runs begin and end at grapheme boundaries.
`eventLast` still iterates code points and can insert a combining mark, variation
selector, or ZWJ separately from an ASCII base. Tests pin the dispatched chunks;
they do not claim a device editor's rendered result.

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

| Tool                                                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📱 <code>listApps</code>                                                                         | Lists installed apps with optional label/launchability when reported (`device`, `type`, `search`, `profile`; default `type=launchable`).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 🚀 <code>launchApp</code>                                                                        | Launches an app by package name. On iOS, optional `launchArguments` start a fresh process and pass argv after the bundle ID. DEBUG storage writes require a launch-scoped mutation token; the daemon supplies it when `--allow-storage-mutations` is present. Android rejects non-empty launch arguments; an app already in the foreground is a success flagged `alreadyForeground`.                                                                                                                                                                                                      |
| ❌ <code>terminateApp</code>                                                                     | Terminates an app by package name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 💥 <code>crashApp</code>                                                                         | Intentionally crashes a running app through the platform crash path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 📦 <code>installApp</code>                                                                       | Installs an APK, app bundle, or IPA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🗑️ <code>uninstallApp</code>                                                                     | Uninstalls an app by package name or bundle identifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🔗 <code>getDeepLinks</code>                                                                     | Queries an app's deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 📄 <code>putAppFile</code>                                                                       | Writes local-file, UTF-8, or base64 content into an app container.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🧾 <code>resetAppLogs</code>                                                                     | Resets explicitly named app-container log files and their rotated siblings on the session device, with per-path outcomes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📥 <code>stageSharedStorage</code>                                                               | Stages host-file, UTF-8, or base64 fixtures into a bounded Android Downloads namespace for system pickers (Android only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📁 <code>stageSessionDownloads</code>                                                            | Stages fixtures into one bounded child directory of the session device's shared Downloads tree, with optional reset and per-file media indexing (Android only).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ⚙️ <code>getPreference</code> / ⚙️ <code>setPreference</code>                                    | Reads or writes Android system properties, SharedPreferences, or iOS UserDefaults. On iOS, requires `appId` and selects the store with `suite` (not `name`/`fileName`); omitted/`Standard` uses the default store. Uses an already connected embedded SDK, with simulator plist fallback when permitted.                                                                                                                                                                                                                                                                                  |
| 🔑 <code>setKeyValue</code> / 🔑 <code>removeKeyValue</code> / 🔑 <code>clearKeyValueFile</code> | Manages an app key-value storage file. For iOS, an empty `name`, "standard" (any case), or the app bundle id selects standard UserDefaults; other names select a valid suite. Names must have no leading or trailing whitespace. Android uses a SharedPreferences file name without `.xml`. iOS write results include `resolvedStore` when supported by the SDK and runner. `setKeyValue` returns `effectiveValueDiffers: true` and appends a warning when the write persisted but the app reads a different effective value due to an override; remove/clear never produce this warning. |
| 🗃️ <code>listDataStores</code> / 🗃️ <code>getDataStore</code>                                    | Lists or reads Android Jetpack DataStore entries with the SDK adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🗄️ <code>sqlQuery</code>                                                                         | Executes SQL against an app SQLite database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔐 <code>resetKeychain</code>                                                                    | Resets all Keychain data on an iOS Simulator after explicit confirmation; unsupported on Android and physical iOS devices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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

Android app containers accept optional <code>userId</code>, a non-negative safe
integer. Explicit IDs skip user discovery. When omitted, AutoMobile lists users
and checks <code>pm list packages --user N</code> for each one. A sole installed
user wins; for multiple installations, prefer the user of the foreground app
when it is the requested package and that user is a candidate, then the current
user if it is a candidate. Otherwise the error lists candidate IDs and
asks for <code>userId</code>. No installation reports the app and device; failed
user discovery asks for an explicit ID. Resolution happens once per operation,
including once for a multi-file batch. A single-user device needs one user-list
read and one package-list read, with no foreground-app or current-user probe.

Android <code>externalFiles</code> uses the same user resolution and maps user 0
to <code>/sdcard/Android/data/{appId}/files</code>, preserving the verified argv;
nonzero users map to <code>/storage/emulated/{userId}/Android/data/{appId}/files</code>.
It continues to use plain <code>adb shell</code> and <code>adb push</code>.
**Unverified, from Android scoped-storage documentation:** on Android 11+
(API 30+), shell read/list access to other apps' <code>Android/data</code>
directories is not guaranteed and push may fail with permission denied. This is
an inference about shell access from the
[Android storage restrictions](https://developer.android.com/about/versions/11/privacy/storage#other-apps-data),
not a device verification or an access bypass.

Private containers (<code>documents</code>, <code>cache</code>, and <code>tmp</code>)
use <code>run-as</code> and require a debuggable app. Nonzero users add
<code>--user N</code>; user 0 keeps the plain command. Missing-package and
non-debuggable errors name the nonzero user. If the output indicates an unsupported
<code>run-as --user</code> option, the error says it appears unsupported on this
Android version (**unverified which API level**). Omit <code>userId</code> only
if the app is installed for the primary user, or use a debuggable build through
an adb-user-0 session. Omission still follows the resolution rule above.
Shared-storage <code>user_files</code> and <code>media_library</code> retain their
existing user-resolution behavior. iOS simulator containers include
<code>documents</code>, <code>library</code>, <code>cache</code>, and <code>tmp</code>.

List/read app-file MCP resources use
<code>automobile:devices/{deviceId}/apps/{appId}/files/{container}{?userId}</code>
and <code>automobile:devices/{deviceId}/apps/{appId}/files/{container}/{path}{?userId}</code>.
Append <code>?userId=10</code> to select a work profile; omit it for the same
Android app-installation resolution as <code>putAppFile</code>. Invalid IDs are
rejected. Returned put and list file links pin the resolved Android user:
explicit IDs always round-trip, including <code>?userId=0</code>, without extra
discovery. Auto-resolved nonzero users always retain <code>?userId=N</code>;
auto-resolved user 0 retains <code>?userId=0</code> only when the app is installed
for several users. A sole user-0 installation keeps the existing query-free URI.
This rule also applies to <code>externalFiles</code>. iOS URIs have no user query.

</details>

## Devices & system state

Devicectl-only simulator features such as orientation, per-display screenshots, and Duo hinge/active-panel support are Planned (#8349, #8350, #8351) and will require CoreDevice >= 651. No current tool is gated on CoreDevice version. See the [iOS simctl and devicectl boundary design](design-docs/plat/ios/simctl-devicectl-boundary.md).

| Tool                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📋 <code>listDevices</code>                                                    | Lists booted devices using the shared device description: identity, runtime, form factor, lifecycle, and session summary; a note points to MCP resources for image detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🖼️ <code>listDeviceImages</code>                                               | Lists configured images using the same canonical identity, runtime, display, lifecycle, provenance, and capability inventory shape as the images resource.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🤖 <code>getAndroid</code> / 🍎 <code>getApple</code>                          | Finds or recovers an Android AVD or iOS Simulator for automation; Android identity includes API level and OS version when known.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 🧱 <code>provisionDevice</code>                                                | Provisions an exact virtual-device identity, with optional resource configuration before automation readiness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ⚙️ <code>setDeviceResources</code>                                             | Configures selected device resources and returns verified, unsupported, or unknown state; omitted settings stay unchanged. Omitted from discovery by default: select it with `setToolEnabled` (case-sensitive `setDeviceResources`) or `--enable-tool setDeviceResources`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 🔧 <code>setActiveDevice</code>                                                | Sets the active device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ❌ <code>killDevice</code> / 🧹 <code>deleteDevice</code>                      | Stops a device, or stops and permanently deletes it. Both accept `force: true`, which drops every AVD-name comparison for a wedged Android emulator — the emulator-console confirmation and the platform kill's own re-discovery check — and acts on whatever occupies the serial; it does not bypass serial selection, nor the refusals raised when the pooled entry was retired and replaced mid-action, or when no booted target can be identified at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 📸 <code>deviceSnapshot</code>                                                 | Captures or restores a device snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🔄 <code>rotate</code>                                                         | Changes device orientation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 📖 <code>setPosture</code>                                                     | Sets an Android device posture or the iPhone Duo simulator hinge posture (closed, half_opened, opened). The Resizable Android emulator also accepts a phone, unfolded, or tablet display preset. Physical iOS and non-foldable iOS simulators return unsupported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 🌐 <code>openLink</code>                                                       | Opens web URLs or routes app and universal deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 🧰 <code>homeScreen</code> / <code>recentApps</code> / <code>systemTray</code> | Controls core system surfaces and notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 🔓 <code>wakeAndUnlock</code>                                                  | Wakes and unlocks the keyguard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🌍 <code>changeLocalization</code>                                             | Changes locale, time zone, text direction, time format, and calendar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ⚙️ <code>getDeviceState</code> / ⚙️ <code>setDeviceState</code>                | Reads or changes Do Not Disturb, simulator biometric enrollment, network condition, and static geolocation. Set a point with `location: { mode: "static", latitude: 37.7749, longitude: -122.4194 }` on an Android emulator or iOS Simulator. Latitude must be within −90..90 and longitude within −180..180. The result echoes the applied coordinate; location read-back is unavailable, and physical devices return an unsupported error. `getDeviceState` also reads back the Android connectivity toggles — `airplaneMode`, `wifiEnabled`, `bluetoothEnabled`, `locationEnabled` — in a single adb round-trip, so a toggle can be checked before it is flipped; a bare call returns `doNotDisturb` + `connectivity`, and `include` selects any subset. A connectivity field is `true`/`false`, or omitted when the device could not answer it (key absent on this API level, or an unparsable value) — omitted never means off. Connectivity is unsupported on iOS: Airplane mode, Wi-Fi, Bluetooth and Location have no simctl/devicectl read verb, and a simulator shares the host's network stack. Degraded profiles — including `offline` — are best-effort cellular shaping on an Android emulator (`adb emu network …`/`gsm data off` plus a best-effort Wi-Fi disable), reported `partial`: they may not affect Wi-Fi or app traffic. Only reset to `none` is fully verified. A session restores the network to a clean `none` state on release. Network shaping is unsupported on physical Android and all iOS. |
| 🔠 <code>displayConfig</code>                                                  | Reads or sets font/text scale, effective display density, and light/dark theme for adaptive-layout and large-font accessibility testing. Android supports all three fields (density overrides are best-effort on physical devices); the iOS Simulator supports theme only, via `simctl ui appearance`; physical iOS is unsupported. Omitted from discovery by default — select it with `setToolEnabled` (case-sensitive `displayConfig`) or `--enable-tool displayConfig`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 🧬 <code>getIosSimulatorCapabilities</code>                                    | Discovers biometrics for a selected iOS Simulator device type and runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🫆 <code>biometricAuth</code>                                                  | Simulates biometric authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 📳 <code>shake</code>                                                          | Shakes an Android emulator or iOS Simulator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📞 <code>phoneCall</code> / 💬 <code>sendSms</code>                            | Simulates an Android emulator phone call or incoming SMS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🔔 <code>postNotification</code>                                               | Posts a notification through Android SDK hooks or iOS Simulator push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 🔔 <code>getNotificationPolicy</code> / 🔔 <code>setNotificationPolicy</code>  | Reads or changes app notification and Do Not Disturb policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 🛂 <code>getAppPermissions</code> / 🛂 <code>setAppPermissions</code>          | Reads or changes app permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Location route playback uses `setDeviceState` with `location: { mode: "route", waypoints: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }], durationMs: 10000 }`. Provide exactly one of positive, finite `durationMs` or `speedMetersPerSecond`. A route needs at least two ordered waypoints; latitude is −90..90, longitude is −180..180, and optional altitude is finite. `loop` defaults to false; `updateIntervalMs` defaults to 1000 and accepts integers from 200 to 60000. Starting a route returns immediately with its waypoint count, total distance, expected duration, loop, interval, and method. iOS Simulator interpolates on the host and sends repeated `simctl location set` commands. Three consecutive fix failures stop playback and are logged; the next location write reports the failed route in `previousRoute` with `endedReason: "failed"` and `lastError`.

One route runs per device. A static fix, new route, `location: { mode: "stop" }`, session release, unbind, or device removal cancels it. Stop reports `stopped: false` when idle and `previousRoute` when a route ended, including its `endedReason` (`completed`, `failed`, `replaced`, or `stopped`) and any `lastError`.

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
waits need a device that reports posture: supported Android foldables and iPhone
Duo report it in the display stamp. Posture waits fail immediately with an
actionable error only when hydrated display inventory confirms a single panel.
Multi-panel or unavailable inventory keeps polling, including a first capture
with no hierarchy and an unknown display stamp. Posture waits also tolerate
transient observation failures after the first capture during a fold;
cancellation still propagates. `activeDisplay` fails immediately only when the
known inventory's panel list has no matching key or role. A single-panel device
asking for its own panel's key or role keeps waiting normally and resolves on a
match. An unavailable inventory or an unknown panel list keeps polling, as does
a present panel whose first display stamp is unknown.

Posture-only waits use the independently read display stamp without requiring a
new hierarchy timestamp. Combined text/element predicates and settling retain
the hierarchy freshness requirement, and all specified predicates must match.
On timeout, the last observation is returned with `timedOut: true` and
`awaitTimeout: true`, plus `timeoutReason`, for example:
`Timed out after 5000 ms waiting for posture "closed"; last observed posture "opened"`.
If posture was never known on a multi-panel device and no hierarchy was captured,
the reason ends with `posture was never observable because no hierarchy was captured`.
If inventory was unavailable and posture was never known, it ends with
`display inventory was unavailable so posture support was never confirmed`.
Active-display timeouts use the parallel reasons `the active display was never observable because no hierarchy was captured` when no known stamp appeared and no hierarchy was captured, or `display inventory was unavailable so the active display was never confirmed` when inventory was unavailable and no known stamp appeared. Otherwise the reason names the last observed active display key and role.

`display.generation` is the host tracker’s `identityRevision`.
Generation advances on notifyTransition calls for panel key, role, or posture changes, Android non-swap size changes and accepted pushed display_transition events (changed with a different panel key or non-swap size, added, removed, or device_state changes), iOS multi-panel rotation, and iOS setPosture hinge, observed identity, and settled notifications (potentially several increments per request), but not on captures, Android pure width/height swaps, or iOS same-observation geometry corrections.
`staleDisplay.observedGeneration` is the `display.generation` stamp from the
caller's last rendered observation, persisted even when a transition clears the
cached hierarchy. A capture that straddles a transition retains its capture-start
generation, and refusals report that stamp rather than its full internal revision.
`currentGeneration` is the identity generation at the fence; `currentDisplayKey`
is included only when a panel has been accepted after the latest transition.
Without a stored stamp, in-flight fences use the action-start identity generation.
Without a prior rendered revision, entry fences do not reject the action; in-flight
transitions still do. Explicit display targeting still requires a prior observation
of that panel and keeps its existing missing-observation error.

Generation is comparable only within one session: it restarts at 0 when the device is released or the session ends, and on daemon restart.

An action-observation diff includes `displayChanged: { from, to }` when the
panel key, role, or posture changes. Generation alone does not create a
display change entry.

For the observe → act → observe behavior behind interaction tools, see the
[interaction loop](design-docs/mcp/interaction-loop.md). For per-session public
tool selection, see [Dynamic Tools](using/dynamic-tools.md).

### iOS UserDefaults preferences

`getPreference` and `setPreference` use `scope: "userDefaults"`, `appId` (bundle ID),
`key`, and optional `suite`. Unlike `setKeyValue`, these tools reject `name` and
`fileName`; use `suite` to select a custom UserDefaults suite. Omit it, pass an
empty string, or use `"Standard"` for the app's standard store. For example:

```json
{ "scope": "userDefaults", "appId": "com.example.app", "suite": "mt8327Suite", "key": "kv8327" }
```

On simulators, reads and writes use the embedded AutoMobile SDK only when an
existing runner connection is open, with storage inspection enabled. These tools
never start a runner. SDK requests are bounded to 2.5 seconds. An SDK missing key
is authoritative. Reads may fall back after a recognized SDK timeout, transport
loss, missing route, or inspection-disabled response. Unknown faults, app mismatch,
and mutation refusals surface as errors.

Writes fall back only when the client is absent or closed before dispatch. Once
an SDK write is attempted, failures never cause a container write; ambiguous
failures report that the write may or may not have been applied. Inspection-disabled
and mutation-refused writes surface errors, preserving the app's opt-in policy.
Read-back verification uses the successful write route and reports the type read
back, while comparing according to the requested input type. SDK-redacted reads
return `found: true`, `redacted: true`, `value: null`, and the original canonical
type. The host honors the SDK's explicit `redacted: true` flag regardless of value,
and falls back to the `[REDACTED]` sentinel for older SDKs when the flag is absent.
The storage entries resource keeps each redacted list entry's SDK type vocabulary
(for example, `STRING`) while returning `value: null` and `redacted: true`; single
reads use the canonical type (for example, `string`). Unredacted list entries
retain their existing wire shape.
New SDKs also omit the flag for ordinary values, so a literal `"[REDACTED]"` string
remains indistinguishable from older SDK redaction and is treated as redacted.
A successful write with redacted read-back returns `success: true`, `redacted: true`,
`verified: false`, and a warning that the value was written but not compared;
`verified: false` means equality was not established, not that the write failed.
Container-plist and defaults reads treat the sentinel as an ordinary string.

The container route reads `Library/Preferences/<suite>.plist` for custom suites
and `<appId>.plist` for the standard store, preserving the bundle ID's casing.
Omitted, empty/whitespace, any case of `standard`, and a suite equal to the bundle
ID (case-insensitive) all select the standard store; the SDK receives `Standard`.
App-group suites (`group.*`) live in a separate group container and require the
connected SDK. Without it, reads return not-found with a warning, and writes fail.
Physical-device access remains unsupported.

Plist reads warn that the on-disk value may lag a running app's cfprefsd state.
Container writes via `defaults write <absolute path>` bypass the preferences daemon:
a running app may not see the change, and cfprefsd may overwrite the file with
cached state until the app restarts. `verified: true` proves file content only.

Canonical types are `string`, `bool`, `int`, `float` (SDK FLOAT/DOUBLE and plist
real), `date`, `data`, `array`, `dictionary`, and `unknown` for unrecognized SDK
types. Unsafe integers retain their exact decimal string with type `int`. Date
and data values are ISO and base64 strings. Plist non-finite reals retain type
`float` and values `"nan"`, `"inf"`, or `"-inf"` so JSON does not turn them into null;
these strings are also preserved recursively inside collections.
Arrays/dictionaries are JSON strings. SDK collections that parse as their declared
JSON shape carry `valueFormat: "canonical-json"`; current SDKs encode nested dates
as ISO strings, data as base64, and non-finite numbers as `"nan"`, `"inf"`, or `"-inf"`.
If an older SDK falls back to Swift interpolation (for example, nested Date/Data),
the raw description is retained,
`type` is `unknown`, and `valueFormat` is `"sdk-description"`, with a warning about
lossy encoding. Reading via the container-plist route when the SDK is disconnected
returns recursive JSON with ISO/base64 leaves. `valueFormat` is omitted for other
values and routes.
Android additionally retains `long` and `stringSet`.

The optional iOS `resolvedStore` is a plain name: `standard` or the custom suite.
The separate optional `storeRoute` is `sdk`, `container-plist`, or `defaults`.
Simulator-global `defaults` domains remain available to direct internal calls
without `appId`; their `resolvedStore` is the domain name, which cannot start with
`-`. The MCP input schema requires `appId`.
