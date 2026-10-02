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
`cover`, `rear`, or `external`), `"active"`, or opt-in Android `"all"`. With no argument, it follows
the focused window's panel when available, then the current posture's default
panel. The returned `display` stamp identifies the panel actually observed.
For Android it uses the physical panel key from the hierarchy's `panelUniqueId`
or mapped `displayId`; for iOS it uses the matched simulator screen name. Its
`role` comes from inventory. Android foldables include the current device-state
`posture` when available. Multi-panel iOS simulators infer posture from the active
panel (cover → `closed`, inner → `opened`), retaining a successful `setPosture`
value such as `half_opened` while that panel matches and no transition occurs.
This is not read from the device. Single-panel simulators and physical iOS
devices report `unknown`.
When inventory has two or more panels, `otherDisplays` lists each remaining
panel's `key`, `role`, and pixel `size` (`width`, `height`).
Android routes explicit hierarchy and screenshot reads to the selected display;
on iOS, only the currently live simulator panel can be observed.

`observe({ display: "all" })` opts into the proposed additive shape for #8256
(owner confirmation is pending): the top level retains the ordinary active-panel
observation, and `displays` contains every inventory panel, including the active
one. Each entry has `display`, `screenSize`, `freshness`, and the requested
`viewHierarchy` or `skeleton`/`context` projection (including keyboard, capture
truncation metadata, and `observeScope` when present). Panels are read sequentially within the observe
deadline (the existing 15-second hierarchy budget when no transport deadline is
supplied). Unavailable panels remain in the list with a typed freshness reason;
panels left after the deadline carry `request_timed_out`.

With a one-panel inventory, `displays` contains that panel. Without inventory
(including ordinary single-screen discovery), `displays` is omitted and no new
field is added. `waitFor`, `raw: true`, and `includeScreenshotImage: true` are
rejected with `"all"`; use a separate single-panel observe. iOS rejects `"all"`.
The active entry may include the normal settled `screenshotPath`; extra-panel
screenshot paths are omitted to avoid overwriting shared screenshot state.
Session-less `deviceId` reads support `"all"` with the same read-only service
access as explicit-panel reads; they never start or recover a service.

An aggregate read does not update observation caches, session baselines,
snapshot references, or display-transition fences. Observe one explicit panel
before acting on it; `"all"` is an observe selector only. The ordinary output
size limit still applies: a large aggregate is stored intact in a tool-output
artifact and the response supplies its artifact pointer.

`tapOn`, `tapAt`, `swipeOn`, `pinchOn`, `dragAndDrop`, and `sendKeys` accept the
same optional `display` selector. First observe the target panel, then pass the
same panel to the action. An explicit action rejects coordinates from another
panel and asks you to re-observe the target. A display-transition refusal carries
`staleDisplay: { observedGeneration, currentGeneration, currentDisplayKey?, retry: "observe" }`
on the failure result (and in MCP `structuredContent`), with the same generations
and re-observe instruction in `error`. Android gestures use CtrlProxy with the
selected panel's logical `displayId` when the APK advertises `gesture_display_id_v1`.
Older APKs retain `input touchscreen -d` routing for taps, swipes, and drags;
`pinchOn` on a non-default display reports the existing support limitation.
`swipeOn` on an Android display honours `speed`, `boomerang`, `apexPause`, and `returnSpeed` (each boomerang leg re-checks the display fence). Android also supports `lookFor` with `display`: scroll until found, observing and swiping the selected display on every iteration, with the display fence re-checked before each swipe. As on the default path, `boomerang` cannot be combined with `lookFor`. `includeSystemInsets` is supported only when the selected display reports its own available system insets; an explicit value fails before dispatch if those insets are unavailable. `false` excludes those insets and `true` uses the full rect. A plain display swipe with this option omitted retains its existing full-rect behaviour; a search excludes available selected-display insets and ignores unavailable inset values. `autoTarget` is supported with Android `display` as opt-in: `true` selects a scrollable container from the selected display; omitted or `false` keeps a plain display swipe. Explicit `container` and `lookFor` ignore `autoTarget`. Internal `scrollMode` selects the dispatch route: `"adb"` forces display-targeted adb input, `"a11y"` requires CtrlProxy display capability for a non-default display, and omitted keeps capability-based routing. A CtrlProxy display-dispatch failure is returned directly without retrying through adb. `focusTarget` remains rejected with `display`. On iOS, `lookFor`, `includeSystemInsets`, `autoTarget`, and `scrollMode` remain rejected with `display`.
Default-display gestures omit `displayId`. A CtrlProxy display-dispatch failure
is returned directly without retrying through adb. iOS accepts only its live panel.
On iOS, `tapOn`, `swipeOn`, `dragAndDrop`, and `pinchOn` validate the selected
panel, then use their existing CtrlProxy gesture path on that live panel.
For Android `sendKeys`, text, clear, and IME actions require a selector when
`display` is set so the input field can be focused on that panel. Discrete key
events use `input -d` directly.

### Gesture timing bounds

`dragAndDrop` accepts `pressDurationMs` from 600 to 3000 ms,
`dragDurationMs` from 300 to 2000 ms, and `holdDurationMs` from 100 to 3000 ms.
The schema and action share these bounds.

With `swipeOn({ boomerang: true })`, `apexPause` accepts any nonnegative
finite duration in milliseconds, and `returnSpeed` accepts any positive finite
multiplier. Their defaults remain 100 ms and 1 respectively. There is no
schema upper bound; long gestures remain subject to request/runner deadlines.

`pinchOn` requires positive `scale`, `distanceStart`, and `distanceEnd` when
supplied; nonpositive values are rejected before gesture dispatch. Its optional
`duration` must be a positive integer from 1 to 10000 ms; the default remains
300 ms. This is a deliberate input tightening: zero, negative, fractional, and
over-10000 ms durations are rejected by both the schema and action.

For `tapAny` with `action: "longPress"`, the effective maximum duration is
2147323897 ms after rounding. The action derives this limit from the timer
ceiling minus non-press overhead and the maximum search window; the schema
advertises it without an upper-bound constraint.

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

For hierarchy-derived points use native `tapAt({ x, y })` (the default
`coordinateSpace: "absolute"`). For screenshot-derived points prefer:

```ts
tapAt({
  image: {
    unit: "normalized",
    x: 0.25,
    y: 0.5,
    source: { crop: observation.crop, rotation: observation.rotation },
  },
  snapshotId: observation.snapshotReference.snapshotId,
});
```

Pass back the whole `crop` object from the same observe; `cropPath` is optional
and ignored. For a full screenshot use `source: { screenshot: { screenSize,
screenshotOrientation, rotation } }` from that observe instead. Native-oriented
rasters require `rotation`; display-oriented rasters need no turn. Image input
is mutually exclusive with outer `x`, `y`, and `coordinateSpace`. Add `snapshotId`
for existing stale-frame validation; changed screen dimensions always reject.

Fractions survive preview resizing. `unit: "pixels"` is for callers measuring
the real file, with half-open ranges `[0, imageWidth)` / `[0, imageHeight)`;
full-screen pixels additionally require caller-supplied `imageSize: { width,
height }`, since observe does not return full raster dimensions. Out-of-range
unit mix-ups reject; in-range mix-ups cannot be detected, so agents should use
`normalized`. Normalized endpoints 1 resolve just inside the image. For fractional
crops, normalized spans the clipped native bounds; pixels preserve the raw
floor/ceil-snapped raster padding using its origin and actual scale. Orientation
is aligned automatically, and results report native `x` / `y`.

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

Returned full-screen fresh (settled or device-read), cached fallback, per-panel/per-display,
and crop (`crop-*` from `observe({ crop })` and `snapshot-of-*`) paths are protected
in the returning process for **30 seconds
from return**, including when a cached path is returned again. Other processes sharing
this directory honor a 30-second file-mtime floor, but cannot see these process-local
protections. Protection bookkeeping is bounded to 4096 paths across devices and sessions;
on overload the oldest protection is dropped with a warning, so that path may lose its
return-time guarantee. Release or device removal drops the cache references; it does not
delete the file early. Eligible unreferenced, unprotected files may be removed by size
cleanup after the minimum lifetime (128 MiB target). Recent or referenced files can
temporarily keep the directory over budget. Stale unreferenced, unprotected screenshot
files are swept after **24 hours** by mtime on capture construction, including the first
cleanup after restart; idle processes do not sweep. Callers needing a path longer
**must copy the file**. Return-time protection ends on process exit or crash.

For encoded captures, pass `screenshotOptions` with `screenshot: "settled"`,
`includeScreenshotImage: true`, or `crop`,
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
`deviceId` reads, which never return a reference. On iOS, `observe.rotation` uses
runner-reported interface orientation when known; otherwise the settled screen
shape supplies 0 for portrait (`width < height`) or 1 for landscape (including
square screens). This fallback cannot distinguish upside-down portrait or
landscape direction. Runner landscape on a fixed portrait display resolves to 0;
runner portrait on a landscape-shaped unfolded panel is preserved.

Rotation values are 0 portrait; 1 landscape with the device top toward the left
(counter-clockwise, iOS `.landscapeLeft`, Android `ROTATION_90`); 2 portrait upside
down; 3 landscape right (iOS `.landscapeRight`, Android `ROTATION_270`). Values 2
and 3 on iOS require runner evidence. The host fallback affects only
`observe.rotation`, preserving the runner's `viewHierarchy.rotation` for screenshot
crop direction.

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

### Cropping an observe screenshot

`observe({ crop: { element: { text: "Gmail" } } })` saves a PNG of one exposed
bounded element. `element` uses the same selector union as `tapOn`: `elementId`,
`testTag`, `text`, `textAny`, or `accessibilityLink`. Resolution uses the shared
`ElementResolver` with inspection intent, without promoting to a tap target.
The match must be unique; there is no first/random choice or index fallback.
`textAny` tries ordered variants and stops at the first matching variant;
an ambiguous matching variant fails. Embedded semantic accessibility links have
no independent element bounds and fail with an actionable request to select the
owning element instead.

For a screen rectangle, use
`observe({ crop: { rect: { x: 10, y: 20, width: 30, height: 40 } } })`.
Exactly one of `element` or `rect` is required inside `crop`. Rectangle numbers
must be finite, with positive width and height. Units are physical pixels on
Android and logical points on iOS, matching `screenSize` and `tapAt`.

`crop` implies a settled screenshot when `screenshot` is omitted. Explicit
`screenshot: "async"` or `"none"` is a validation error: async is rejected rather
than upgraded because a crop requires waiting for the completed capture.
`screenshotOptions` may encode the full screenshot as PNG, JPEG, or WebP;
the crop always uses that captured raster and encodes PNG without resizing.
Lossy full-screen encoding therefore also affects the crop's source pixels.
`includeScreenshotImage` retains its existing meaning for the full screenshot
only; crop bytes are never embedded. Cropping reads the captured file even when
inline image delivery is disabled.

Observe captures the screen once through its settled path, then crops that file
using the returned hierarchy's screen size, rotation, and native scale. With
`waitFor` (and its optional `settled` quiet gate), this is the final capture after
polling completes. A timed-out wait retains observe's usual timeout metadata and
crops its terminal observation. The original `screenshotPath` and
`screenshotOrientation` remain present alongside `crop`:

- `cropPath`: local filesystem path to the securely written PNG.
- `unit`: `"pixels"` or `"points"`.
- `requestedBounds`, `clippedBounds`: native `{ left, top, right, bottom }` bounds.
- `clipped`: whether visible-screen clipping changed the requested bounds.
- `screenSize`, `imageSize`: native screen dimensions and upright output crop PNG
  dimensions.
- `pixelsPerNativeUnit`: raster scale `{ x, y }`; actual raster dimensions handle
  Display Zoom and downsampled devices, with floor/ceil covering fractional points.
- `scaleProvenance`: `"native-scale-confirmed"` or `"raster-dimensions"`.
- `rasterBounds`: integer bounds read from the captured source raster before
  orientation normalization.
- `screenshotOrientation`: orientation of the output crop PNG (`"display"`).
  Native iOS framebuffer crops are rotated upright: rotation 1 maps display
  `(x, y)` to `(screenHeight - y, x)` and rotates the extracted pixels 270°
  clockwise; rotation 3 maps to `(y, screenWidth - x)` and rotates 90° clockwise;
  rotation 2 maps to `(screenWidth - x, screenHeight - y)` and rotates 180°.
  A raster already reported in display orientation is neither remapped nor
  rotated. No downscaling occurs. The full screenshot retains its own
  `screenshotOrientation`. The same crop mapping and normalization apply to
  `snapshotOf`.

The hierarchy/elements are unchanged by crop. Element resolution uses the full
filtered exposed hierarchy before raw append or skeleton projection; `raw` does
not switch crop to a separately fetched raw tree. `project: "full"` (including
raw's default full projection) applies `scope` to element lookup exactly as it
does to the returned hierarchy. Skeleton projection already ignores structural
scope transforms, so element lookup also retains the full exposed tree in that
mode. Rectangles always use the selected display's full screen coordinates;
`scope` does not shift their origin or clip them to a subtree.

Sessionless `deviceId` reads support crop against that read's hierarchy and a
fresh settled screenshot. Their existing `waitFor`, raw, and skipBackStack
restrictions still apply. Crop rejects capture failures before cached screenshot
fallback. `display` selects the same panel for hierarchy, screenshot and crop;
non-default panel coordinates and dimensions are used. `display: "all"` is
explicitly rejected with crop; choose one panel.

Invalid input forms or screenshot modes fail validation. Missing or ambiguous
elements, empty/off-screen rectangles, missing hierarchy geometry, missing or
invalid screenshots, capture failures and crop/write failures throw
`ActionableError`. Partially visible rectangles are clipped to the screen.
There is no full-screen fallback, cached crop, silent retargeting, or successful
result with `screenshotSettled: false` for a crop request.

### Screenshot delivery to local and remote clients

For a local client with access to the AutoMobile host filesystem, `observe` returns
the screenshot path in its structured observation. This remains the default: omitting
`includeScreenshotImage` or setting it to `false` never embeds image bytes; without
`crop`, it also avoids reading them for tool delivery.
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
| 👀 <code>observe</code>              | Gets screen hierarchy and screenshot, with optional PNG crop.             |
| 🎯 <code>hitTest</code>              | Estimates hierarchy nodes beneath a coordinate without dispatching input. |
| 🔍 <code>explore</code>              | Explores an app to build a navigation graph.                              |
| 🗺️ <code>navigateTo</code>           | Navigates using the learned navigation graph.                             |
| 📊 <code>getNavigationGraph</code>   | Retrieves the navigation graph for debugging.                             |
| 🔗 <code>identifyInteractions</code> | Suggests likely interactions.                                             |
| 🖍️ <code>highlight</code>            | Draws a visual highlight around a UI element.                             |

### Observe a booted device by ID

`observe {"deviceId":"emulator-5554"}` returns the normal screen observation,
including hierarchy or skeleton, active window, screen size, display, device lock,
and an available screenshot with its fresh or cached label. With `sessionUuid`,
the call is a session observe, and `deviceId` must match that session's device.

#### Reading a device you do not own (`deviceId`)

A deviceId read is connect-only: it never installs, enables, sets up, starts or
restarts CtrlProxy or the iOS runner. Whether it may start a service is an open
owner decision tracked in #8621. It does not acquire a session or change ownership.

Unavailable hierarchies have `freshness.category: "unavailable"`. The table shows
exact `unavailableDetail` templates (`${deviceId}` and `${timeoutMs}` are replaced
with the device ID and connection budget; the default hierarchy budget is 15000ms).
The detail is also appended to `freshness.warning` and limited to 500 characters.

| `unavailableReason`  | `unavailableDetail`                                                                                                                                                                                                                                   | Caller recovery                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_lost`    | `Device ${deviceId} has no reachable hierarchy service`                                                                                                                                                                                               | An unowned device needs an already-running service; arrange setup through a session, then retry.                                                                              |
| `connection_lost`    | `Device ${deviceId} is session-owned and has no connected hierarchy service: the owning session's hierarchy client is disconnected. Run a session observe as the owner to reconnect it; a deviceId read only connects to an already-running service.` | The owner must run a session observe to reconnect. This read never creates a second client next to the owner's.                                                               |
| `connection_lost`    | `Device ${deviceId} hierarchy service did not answer`                                                                                                                                                                                                 | The owned client's socket was connected but the read received no hierarchy; retry, or have the owner check the service through a session observe.                             |
| `connection_lost`    | `Device ${deviceId} hierarchy read timed out`                                                                                                                                                                                                         | The connection consumed the hierarchy budget before extraction; retry.                                                                                                        |
| `connection_lost`    | `Observer hierarchy connection for ${deviceId} timed out after ${timeoutMs}ms`                                                                                                                                                                        | The transient connection exceeded its deadline; check service reachability and retry.                                                                                         |
| `request_timed_out`  | `Owner's in-flight request exceeded the observer hierarchy deadline`                                                                                                                                                                                  | Let the owner's tracked request finish, then retry.                                                                                                                           |
| `connection_lost`    | Other caught connection/conversion error text                                                                                                                                                                                                         | Check the reported error and retry; cancellation propagates as an error instead of an unavailable observation.                                                                |
| `incomplete_capture` | Absent for a rootless incomplete Android capture                                                                                                                                                                                                      | Retry after the UI settles; follow the cause-specific freshness warning if the capture remains incomplete. Observer reads do not run the device-writing UIAutomator fallback. |
| `unknown`            | Absent for a returned error hierarchy or failed platform validation without a typed cause                                                                                                                                                             | Retry and inspect the service's capture; this is the freshness fallback for an unclassified unavailable hierarchy.                                                            |

The observer's result does not update the owner's session baseline, snapshot
references, observe cache or its generation, screenshot state, navigation graph,
stream, active-window cache, or display-transition tracker. Android display/posture probes may read
shared mappings but never populate or refresh them. Android device commands issued
through ADB are read-only (including streamed `screencap`, `dumpsys`, and display
and device-state queries); they do not delay, abort, fail or reorder an ADB-driven
owner action. A read during an action can show intermediate UI: it is not an
atomic snapshot of that action. Hierarchy reads queue behind requests tracked by
the service client, within the hierarchy budget. Android still delivers a changed
observer hierarchy frame through the normal native push path; those ordinary
service updates can update the stream, navigation and display state independently
of observation assembly. An unchanged observer frame skips that path. Unowned
reads close their temporary client and release its host port forward/allocation.

Android ADB screenshots share a capture lock; the observer waits at most 10 seconds
without cancelling the owner's capture. Android can capture without CtrlProxy,
and iOS simulators can capture via `simctl`. An unowned physical iOS device without
a reachable runner has no host-side screenshot capture path. Its exact
`screenshotSettledError` is:

> No screenshot could be captured: this unowned physical iOS device has no reachable runner. Physical iOS has no host-side screenshot capture path without the runner.

With no eligible cached screenshot, `screenshotPath` is absent. Otherwise the
cached screenshot is returned with `screenshotSource: "cached"` and the same
capture failure detail. In both cases `screenshotSettled` is false. The hierarchy
connection failure still reports `unavailableReason: "connection_lost"`.

Session-less device reads reject `waitFor`, `raw: true`, and `skipBackStack: true`
before capture. Use a session observe (`sessionUuid`) for waiting; `settled`
requires `waitFor` and is covered by that rejection. Use `project: "full"` for the
full filtered hierarchy. Device reads omit `snapshotReference`.

The default `screenshot: "settled"` awaits a fresh validated capture; it does not
wait for action history to settle. `screenshot: "async"` also awaits capture on
device reads, while `"none"` skips it. Capture failures retain eligible cached
screenshots with their cached label and failure details.
With `crop`, capture failure throws before cached fallback; only a fresh validated
settled screenshot is eligible.

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
If a previously observed focused editor or IME window disappears while waiting
for a key, the session reports focus loss and restores the original keyboard.
Enabled-set drift is reported with bounded component IDs; the session never
overwrites external enable/disable changes.

`sendKeys` accepts one optional field selector and an ordered sequence of up to
100 commands. Each `key` command accepts at most 4 raw modifier entries
(`shift`, `ctrl`, `alt`, `meta`), including duplicates. Both limits are enforced
by the schema and preflighted by the action before any key is sent, including
modifiers on semantic keys:

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
| 📄 <code>putAppFile</code>                                                                       | Writes local-file, UTF-8, or base64 fixtures through one target/files contract: private app_containers, bounded Android user_files, or platform-qualified media_library. Opt-in discovery; see the canonical call shape below.                                                                                                                                                                                                                                                                                                                                                            |
| 🧾 <code>resetAppLogs</code>                                                                     | Resets explicitly named app-container log files and their rotated siblings on the session device, with per-path outcomes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📥 <code>stageSharedStorage</code>                                                               | Deprecated alias of putAppFile target.domain user_files (Android Downloads); remains until equivalent workflows are device-verified.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 📥 <code>stageSharedStorageFixtures</code>                                                       | Deprecated alias of putAppFile target.domain user_files (Android Downloads); remains until equivalent workflows are device-verified.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 📁 <code>stageSessionDownloads</code>                                                            | Deprecated session-bound alias of putAppFile target.domain user_files (Android Downloads); retains session ownership checks and remains until equivalent workflows are device-verified.                                                                                                                                                                                                                                                                                                                                                                                                   |
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
<summary>putAppFile canonical call shape and platform-qualified examples</summary>

Every target uses `target` plus a non-empty `files` array. Each file has a
normalized relative `destinationPath` and exactly one of `sourcePath`,
`contentText`, or `contentBase64`. Device selection uses the existing `platform`,
`deviceId`, or `sessionUuid` fields. Optional `userId` selects an Android profile.

Android app containers (private containers require a debuggable app):

```json
{
  "name": "putAppFile",
  "arguments": {
    "platform": "android",
    "target": { "domain": "app_containers", "appId": "com.example.app", "container": "documents" },
    "files": [{ "destinationPath": "fixtures/settings.json", "contentText": "{\"enabled\":true}" }]
  }
}
```

iOS Simulator app containers (`documents`, `library`, `cache`, or `tmp`):

```json
{
  "name": "putAppFile",
  "arguments": {
    "platform": "ios",
    "deviceId": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    "target": { "domain": "app_containers", "appId": "com.example.app", "container": "documents" },
    "files": [
      { "destinationPath": "fixtures/welcome.png", "sourcePath": "/Users/me/fixtures/welcome.png" }
    ]
  }
}
```

Android user files (reset removes only this declared Downloads namespace;
`indexMedia` requests indexing and defaults to false on the unified surface):

```json
{
  "name": "putAppFile",
  "arguments": {
    "platform": "android",
    "target": {
      "domain": "user_files",
      "namespace": "picker-fixtures",
      "reset": true,
      "indexMedia": true
    },
    "files": [{ "destinationPath": "photo.png", "sourcePath": "/Users/me/fixtures/photo.png" }]
  }
}
```

Android media library (image, video, or audio filenames supported by MediaStore;
indexing is required and discovery is verified by the provider):

```json
{
  "name": "putAppFile",
  "arguments": {
    "platform": "android",
    "target": { "domain": "media_library" },
    "files": [{ "destinationPath": "photo.png", "sourcePath": "/Users/me/fixtures/photo.png" }]
  }
}
```

iOS Simulator media library (supported image/video files only; imports through
`simctl addmedia`, returns `media_import` with picker visibility unverified):

```json
{
  "name": "putAppFile",
  "arguments": {
    "platform": "ios",
    "deviceId": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    "target": { "domain": "media_library" },
    "files": [{ "destinationPath": "photo.png", "sourcePath": "/Users/me/fixtures/photo.png" }]
  }
}
```

Physical iOS has no production `putAppFile` app-container or media-library
provider; user_files is Android-only. Media libraries have no list/read resource.
Use `storage/capabilities` for provider-derived operations and prerequisite states;
inspect structured per-file `effects` for indexing/import/discoverability outcomes.
These provider contracts do not establish device verification of legacy replacement.

Canonical read-only resources are:

- `automobile:devices/{deviceId}/storage-domains/app_containers/{appId}/{container}{?userId}` (list), with `/{path}` before the query for read.
- `automobile:devices/{deviceId}/storage-domains/user_files/{namespace}` (list), with `/{path}` for read (bounded Android Downloads only).

Compatibility aliases remain readable during the transition until device
verification permits retirement: `automobile:devices/{deviceId}/apps/{appId}/files/{container}[/{path}]{?userId}`
and `automobile:devices/{deviceId}/downloads/{namespace}[/{path}]`.
Returned write/list file URIs continue to use these aliases. Paths are normalized,
percent-encoded by segment, and cannot traverse out of the target.

Session enablement currently controls MCP discovery only; an unlisted tool stays
callable. `putAppFile` stays default-disabled; the legacy defaults stay unchanged
(`stageSharedStorage` true, `stageSharedStorageFixtures` and `stageSessionDownloads` false).
The target policy resolves each exact tool name as session override, then startup
default, then its registration default, and OR-combines effective names:
app_containers and media_library use only `putAppFile`; user_files uses
`putAppFile`, `stageSharedStorage`, or `stageSharedStorageFixtures`. Disabling an
alias suppresses its default; disabling `putAppFile` does not veto an enabled alias.
A default session therefore enables only the user_files target policy. Legacy
enablement never enables private writes or lists `putAppFile` in discovery.
Stored overrides on legacy names are honored in place, read without migration or
deletion. `stageSessionDownloads` retains its separate session-bound policy and
is not a grant in the unified target resolver. No new MCP call gate is introduced.

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

Clock control uses `setDeviceState` with `clock: { mode: "set", instant: "2026-10-01T00:00:00Z" }`, `clock: { mode: "advance", byMs: 60000 }`, or `clock: { mode: "reset" }`. Set requires ISO-8601 with Z or an explicit offset within **2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z, inclusive** (`MIN_DEVICE_CLOCK_INSTANT_MS` / `MAX_DEVICE_CLOCK_INSTANT_MS`). Advance requires an integer `byMs >= 1000`, at most `MAX_DEVICE_CLOCK_ADVANCE_MS` (315360000000, ten 365-day years). An early device read rejects cumulative targets outside that window before any clock or other field mutation. Immediately before the clock write, after other requested fields, root acquisition and disabling automatic time, advance reads the device again and range-checks the fresh target. A target that leaves the window during those operations returns a typed clock-field failure; other fields retain their results. Read-only root-capability probes and `date +%s` may run during validation. All inputs are validated before applying any field. Only rootable Android emulators support writes; Play Store images, physical Android devices, and all iOS targets return unsupported. Changing the clock affects TLS/certificate validation, token expiry, and the daemon's own freshness checks for that device.

Set/advance disable automatic time. Results report `instant`, `automaticTime`, `requestedInstant`, `appliedInstant`, `readBack`, `verified`, and `toleranceMs` (2000). Commands have **second-level precision**, truncating milliseconds. Advance verifies at least the requested whole seconds minus tolerance, with a minimum one-second movement; a no-op is never verified. Set within tolerance of current device time reports distinct `outcome: "unchanged"`, without writing clock state. Every clock change (set/advance/reset and lifecycle restore, including potentially partially applied failures) invalidates hierarchy/observe caches and freshness baselines so backward jumps cannot reuse stale hierarchies.

At the first mutation, a session records original `auto_time`, ownership of the clock change, and whether AutoMobile rooted adbd. On **session release/rebind/device teardown/reset**, AutoMobile explicitly steps the clock to **HOST-derived real time** (injected host Timer), restores original `auto_time`, and verifies both by read-back, including when original `auto_time=1` because emulators may never automatically re-sync. A failed restore retains pending ownership and retries; the device stays quarantined until restoration succeeds or the device is removed. Each command and the initial teardown wait are bounded; retries use the existing network restore delay (250ms) and pending-device-cleanup pool quarantine, continuing past its bounded retry batch. Reset clears the slot only after verification.

Clock control can **restart adbd on the emulator**; connections such as port forwards may be re-established. It probes `shell id` before rooting and unroots on restore only if AutoMobile rooted it, using bounded `unroot` / `wait-for-device` commands. Unroot failure is logged and best-effort, and does not fail verified clock/auto-time restoration. The existing legacy locale root path likewise waits for ADB and verifies root, with no explicit port-forward/CtrlProxy reconnect step.

The restore slot is **in memory only**: daemon restart loses it, potentially leaving a wrong clock and `auto_time=0`. `reset` is the recovery: with no recorded slot on a rootable emulator, it writes HOST time and `auto_time=1`. Reset checks target support and recorded ownership before root capability. Physical Android and iOS get no root/clock commands; without a slot, a root-refusing Play Store image reports unsupported/"nothing to reset" with no clock mutations. With a slot, refused root reports a typed failure and keeps restoration pending. Session-bound and sessionless clock mutations serialize through one device queue and inherit one original `auto_time` and root-ownership baseline, in either calling order. Session release still restores host time and original `auto_time`; a sessionless claim retains the original baseline until explicit reset or device removal. Removal aborts queued and in-flight clock commands for that device incarnation. Direct/sessionless mode retains original `auto_time` and root ownership per device until explicit reset or device removal; it has no automatic lifecycle restore, so callers must reset explicitly. Operational clock failures are typed per-field failures (`verified:false`) and do not lose other fields' results or prevent a successfully applied network condition's TTL from being armed.

`getDeviceState` with `include: ["clock"]` reads current Android instant and automatic time without root, including physical devices and non-rootable images; iOS reports unsupported. The default read selection remains Do Not Disturb and connectivity.

Location route playback uses `setDeviceState` with `location: { mode: "route", waypoints: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }], durationMs: 10000 }`. Provide exactly one of positive, finite `durationMs` or `speedMetersPerSecond`. A route needs at least two ordered waypoints; latitude is −90..90, longitude is −180..180, and optional altitude is finite. `loop` defaults to false; `updateIntervalMs` defaults to 1000 and accepts integers from 200 to 60000. Starting a route returns immediately with its waypoint count, total distance, expected duration, loop, interval, and method. iOS Simulator interpolates on the host and sends repeated `simctl location set` commands. Three consecutive fix failures stop playback and are logged; the next location write reports the failed route in `previousRoute` with `endedReason: "failed"` and `lastError`.

One route runs per device. A static fix, new route, `location: { mode: "stop" }`, session release, unbind, or device removal cancels it. Stop reports `stopped: false` when idle and `previousRoute` when a route ended, including its `endedReason` (`completed`, `failed`, `replaced`, or `stopped`) and any `lastError`.

During canonical-shape phase 1, every device surface returns the complete shared description:
static facts are top-level, changing state is under `runtime`, and the previous nested and flat
aliases remain present as compatibility fields.

`setPosture` checks Android posture support before sending any fold, unfold,
posture, or device-state override/reset command. It uses hydrated supported
postures, falling back to `cmd device_state print-states` when that inventory is
absent or unreadable. Unsupported requests fail with an actionable error listing
the supported postures/states and confirming that nothing was changed. Empty
state lists and DEFAULT-only states do not establish fold support. If the
device-state service is unavailable, hydrated fold support and an observed
matching posture are required.

After dispatch, Android must reach the requested committed state or, for postures
without a committed-state mapping, report the requested posture in a fresh
observation. If the posture remains old or unknown after the polling timeout,
the error explains that the command was sent but the posture did not change.
Physical foldables may reset to `opened` without an OPENED state only when fold
support is confirmed; they must still confirm the resulting posture.

The initial Android final observation also requests a fresh hierarchy, including
when the committed device state changes without a display transition.
On Android and iOS, `setPosture` checks the final observation's display revision
and retries once with a fresh capture if it is stale or has no revision stamp.
If the retry is also stale, the result preserves that observation's own
`display.generation` and includes `warnings`: ["The posture changed, but the returned
observation predates it. Re-observe before acting."]. Coordinate actions remain
subject to the display-transition fence. On iOS, the settle notification still
follows the final observation; freshness is checked before that notification.
Only a fresh final observation can remember the requested iOS posture for later
`display.posture` reads, including `half_opened` on the inner panel.

Both `rotate` and `setPosture` declare output schemas and return the same JSON
payload in text content and `structuredContent`. Ordinary clients receive
`structuredContent` unless `--tool-results-no-structured-content` is enabled.

`setPosture` returns `message`, the requested `posture`, and `display` (key, role,
posture, generation), with optional `locked` and `warnings`. Unsupported iOS
requests return `{ "status": "unsupported", "message": "..." }`; operational
failures throw actionable errors.

`rotate` returns `success`, `orientation`, `value`, and `message`. Optional fields
include `currentOrientation`, `previousOrientation`, `rotationPerformed`,
`orientationLockHandled`, `orientationLockState`, `warning`, `warnings`, `error`,
`staleDisplay`, `effect`, and a finalized `observation`/`observationDiff`.
Successful no-ops report `rotationPerformed: false`. Returned failures retain
the structured result with `success: false` and set the MCP `isError` flag.

### Keeping an Android orientation locked

With an Android device session (`sessionUuid` and an available session manager),
`rotate` holds the requested orientation by default: auto-rotate stays off until
`lockOrientation: false`, session release, or rebind away from the device. The
session records the original `accelerometer_rotation` and `user_rotation` before
its first settings write and restores both on release or rebind. An already
locked no-op records nothing. If the initial auto-rotate setting is unreadable,
omission leaves it unchanged rather than forcing a lock.

In direct mode (no session or session manager), omission temporarily disables
auto-rotate when necessary and restores it at the end of the call. To keep the
orientation locked past a direct call, pass `lockOrientation: true`:

```json
{ "orientation": "landscape", "lockOrientation": true }
```

`true` differs from the default only in direct mode, where it is the sole way to
hold the lock past the call. In session mode it explicitly requests the same
lock, also recording the restore slot so release restores the original settings;
unlike omission, an explicit lock can force an unreadable initial setting off.

The existing `orientationLockState` reports `locked`, `unlocked`, or `unknown`.
A confirmed final orientation mismatch returns `success: false` with the achieved
`currentOrientation`. `rotationPerformed` is false when the display ended in its
previous orientation. Confirmed failures roll `user_rotation` back to its value
before the call; cancellation and unknown final orientation do not. An unreadable
final orientation retains success with a warning when no mismatch was confirmed.
A persistent lock requires confirmation of the lock and live orientation.

To restore automatic rotation, pass `lockOrientation: false`, for example
`{ "orientation": "landscape", "lockOrientation": false }`. This rotates to the
requested orientation and enables auto-rotate, deliberately overriding an
originally locked `accelerometer_rotation=0`. In session mode, once auto-rotate
is confirmed on, it additionally restores the original `user_rotation` and clears
the slot. A failed user-setting restore adds a warning and retains the slot for
release to retry. These options are supported only on Android.

### Acquiring a device: `avdName`, `udid`, and the `deviceId` alias

`startDevice`, `getAndroid`, and `listDevices` accept `requires: { panels?: number; posture?:
Posture }`. `panels` is a minimum; `posture` must appear in the device's supported
postures. A `foldable` form factor alone does not imply two panels: some foldable
AVDs only change posture on one panel. Booted devices use their display inventory.

Booted device entries in `listDevices` and the booted-devices resource optionally carry
`unhealthy: { reason, since }`. Reasons are `biometric-enrollment`, `network-condition`, or
`clock`; `since` is the daemon's timestamp in milliseconds. Unresolved restore failures
exclude devices from available/idle counts and new session allocation. Biometric and
network failures get three background recovery opportunities with 1s/2s/4s backoff;
a live owner is never restored by this recovery. Clock failures retain the existing
busy quarantine and retry until success or removal. No automatic erase/reboot occurs;
use `killDevice`/`startDevice` for replacement if recovery is exhausted. Health markers
are in memory only: a daemon restart loses them and does not re-detect dirty state.

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
waits need a known posture stamp: supported Android foldables report device
posture, while iPhone Duo simulators report inferred or remembered posture.
Posture waits fail immediately with an actionable error only when hydrated display inventory confirms a single panel.
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

### Device lifecycle structured results

`wakeAndUnlock`, `pressButton`, `launchApp`, `terminateApp`, `getDeviceState`, and
`setDeviceState` declare output schemas and return the same JSON payload in text
content and `structuredContent`. Ordinary clients receive `structuredContent`
unless `--tool-results-no-structured-content` is enabled. Each schema requires
`message`; variant fields are optional, and additional fields are accepted.

`startDevice` also declares an output schema. Its `readiness` evidence contains
`level: "automationReady"`, `checks: ["bootCompleted", "runnerReady", "sessionBound"]`,
`elapsedMs` measured with the injected clock from the start of boot preparation
through session binding, and `recovered` indicating System UI ANR recovery.
The older `acquisition` field remains for compatibility: `"already-booted"` means
adopted and `"cold-boot"` means launched or restarted by this call. Evidence uses
the existing readiness steps without extra device probes. The shared `getAndroid`
and `getApple` result builder also emits this evidence.

`wakeAndUnlock` reports `success`, `platform`, `wasAsleep`, `wasLocked`, and
`unlocked`, with optional `secure`, `usedRecordedCredential`, `error`, and
`warning`. Returned unlock failures do not set MCP `isError`; operational errors
may throw.

`pressButton` reports `success`, `button`, and `keyCode`, with optional `error`,
`warnings`, `staleDisplay`, `effect`, and finalized `observation`/`observationDiff`.
Returned failures retain their structured payload and set MCP `isError`.

`launchApp` reports `success` and `packageName`, with optional `activityName`,
`userId`, `pid`, `alreadyForeground`, `foregroundActivityPackage`, `verifiedBy`,
`verified`, `verifyFailureReason`, `observedAppId`, and action observation metadata.
A stale launch observation may be replaced by `observationOmitted` containing
`reason`, `expectedPackage`, and `reportedPackages`. Failed launches throw
actionable errors; a successful launch with unverified foreground still returns
its verification fields.

`terminateApp` reports `success`, `packageName`, and `wasForeground`, with optional
`wasInstalled`, `wasRunning`, `userId`, and action observation metadata. Already
absent or stopped apps are successful no-ops. Failed terminations throw actionable
errors.

`getDeviceState` and `setDeviceState` report `success`, `deviceId`, and `platform`,
with optional `error` and requested field results: `doNotDisturb`, `connectivity`,
`biometrics`, `networkCondition`, `clock`, and (writes only) `location`. Reads may
also include `displays` and `unsupported` field names. Field results report
`supported` and optional verification, capability, method, values, warning, or
error metadata. Clock writes can report `outcome` as `changed`, `unchanged`, or
`restored`; degraded network writes report capability `partial`. Setter TTL
rejection and biometric capture failures also return structured failure payloads
without MCP `isError`.
