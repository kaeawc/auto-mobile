# Tools

Every tool below can be driven three ways: from the **CLI**
(`bunx @kaeawc/auto-mobile --cli <tool>`), over **MCP** from an AI client, or
directly against the **daemon**'s HTTP endpoint. The tool names and arguments are
the same across all three.

This page reflects the current tool schema. Availability can still vary by
platform, runner, and enabled feature gates; inspect the registered schema for
the exact arguments supported by your connection.

## Shared device and session options

The following tools expose `sessionUuid` and `keepScreenAwake`:

`accessibility`, `accessibilityFocus`, `appLifecycle`, `barrier`, `biometricAuth`,
`changeLocalization`, `clearKeyValueFile`, `clearMockNetwork`, `clipboard`, `crashApp`,
`criticalSection`, `deleteDevice`, `deviceSnapshot`, `displayConfig`, `dragAndDrop`,
`executePlan`, `explore`, `exportPlan`, `getAppPermissions`, `getDataStore`, `getDeepLinks`,
`getDeviceState`, `getIosSimulatorCapabilities`, `getNavigationGraph`, `getNetworkGraph`,
`getNotificationPolicy`, `getPreference`, `highlight`, `hitTest`, `homeScreen`,
`identifyInteractions`, `installApp`, `keyboard`, `launchApp`, `listApps`, `listDataStores`,
`mockNetwork`, `navigateTo`, `network`, `observe`, `openLink`, `phoneCall`, `pinchOn`,
`postNotification`, `pressButton`, `prototype`, `putAppFile`, `recentApps`,
`reconcileDeviceResources`, `recordSteps`, `removeKeyValue`,
`resetAppLogs`, `resetKeychain`, `rotate`, `selectAllText`, `sendKeys`, `sendSms`,
`setActiveDevice`, `setAppPermissions`, `setDeviceResources`, `setDeviceState`, `setKeyValue`,
`setNotificationPolicy`, `setPosture`, `setPreference`, `setUIState`, `shake`, `snapshotOf`,
`sqlQuery`, `startTestRecording`,
`swipeOn`, `systemTray`, `tapAny`, `tapAt`, `tapOn`, `terminateApp`, `uninstallApp`,
`videoRecording`, `wakeAndUnlock`.

`sessionUuid` selects a daemon device session. When an Android session first
runs device setup, `keepScreenAwake` defaults to true. On a detected physical
Android device, AutoMobile attempts to wake the screen and enable staying awake
while plugged in; if that fails, it attempts stay-on and screen-timeout settings.
Pass `keepScreenAwake: false` on the call that first runs this setup to skip it.
The result (including a skip or failure) is cached for the session, so later calls
cannot toggle it. Emulators are skipped; iOS does not apply it. Applied settings
are restored on session release when their original values are known, on a
best-effort basis. The option has no effect outside daemon session setup.

For the tools listed above, use the routing fields their registered schema
exposes: `platform` selects Android or iOS, and `deviceId` identifies the target
device. A string `device` selects a previously allocated plan device label and
requires `sessionUuid`; it takes precedence over `deviceId`. A label requires an
active daemon session. Not every listed tool exposes every routing field.

### Shared observation output options

These tools accept `raw` to return the raw hierarchy and `project` to choose
`"skeleton"` (default) or `"full"` observation output:

`biometricAuth`, `dragAndDrop`, `homeScreen`, `launchApp`, `observe`, `openLink`,
`pinchOn`, `pressButton`, `recentApps`, `rotate`, `selectAllText`, `sendKeys`,
`shake`, `swipeOn`, `systemTray`, `tapAny`, `tapAt`, `tapOn`, `terminateApp`.

Skeleton output contains actionable entries; the collapsed keyboard marker `<ime>` is not a
selector. Use `sendKeys` or `keyboard` for keyboard input.

## Observe & navigate

The default skeleton projection optionally includes `windowTruncations`:
`[{ windowId: 67, package: "com.android.systemui", reasons: ["max_nodes"] }]`.
There is one entry for each window with capture truncation reasons. Complete
windows have no entry; when none are truncated, the field is absent, adding zero
bytes to the output. `package` is optional and comes only from the window's own
metadata or its linked hierarchy root, never from bounds or another window.
The existing flat `truncationReasons` field keeps its meaning and behavior.

- `max_nodes`: this window's share of the node budget was exhausted.
- `max_depth`: the tree was deeper than the depth cap.
- `max_children`: a node exceeded the device's 256-child cap; its later children are missing even from the raw capture.
- `cancelled`: the capture was cancelled mid-walk.

Unknown reason codes from newer APKs pass through unchanged. Reasons within an
entry are deduplicated in capture order; host-output `max_children[...]` caps
are excluded because they do not describe window capture loss.
Observe again after a cancellation, or narrow the next read with an element
query, selector, or the configured `observeScope` experiments instead of
re-reading the whole screen. If the relevant window is complete, act on that
window. The host's observe API does not expose node/depth limit controls: its
hierarchy request omits those optional protocol values, so the APK uses its
defaults (10,000 nodes and depth 100).

For `project: "full"` or `raw: true`, per-window reasons remain at
`viewHierarchy.windows[].truncationReasons`; `windowTruncations` is not duplicated
there. An action diff includes `windowTruncations` from the **current** observation
only, even when full/raw was requested; flat diff reasons can also describe the
baseline. With `display: "all"`, each skeleton display entry carries its own
`windowTruncations`. An APK built before PR #8798 never sends per-window reasons,
so the new field is simply absent: this is additive and nothing else changes.
iOS has no per-window capture reasons.

`observe` accepts an optional `display` panel key, a panel role (`inner`,
`cover`, `rear`, or `external`), `"active"`, or opt-in Android `"all"`. Selection precedence is explicit `display` > session display pin >
focused window > posture default (closed → cover, opened/rear_display → inner).
Explicit `display: "active"` or `"all"` bypasses the pin (`"all"` still reads every panel); `"active"` follows the live focused/active
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

`setActiveDevice` always returns a text JSON envelope containing `message`,
`deviceId`, and `sessionUuid` when provided. Its additive `displayPin` result
field reports the resulting selector string, or `null` after an explicit clear
or a device rebind that clears a pin. The next plain call after a clear omits
`displayPin`, as does a never-pinned session, preserving the existing response bytes. No output schema or
`structuredContent` is added for this tool.

Use `setActiveDevice({deviceId, sessionUuid, display})` to pin a panel key or role
(`inner`, `cover`, `rear`, `external`) for that session and device. Omission leaves
the pin unchanged; a string replaces it; `null` clears it. The selector must exist
in the same inventory used for observe and actions at set time. Ordinary single-display
devices accept the fallback key `"0"`. On a single-display device, `"active"` resolves
to the sole key and stores that key; on multi-display devices, `"active"` cannot be
pinned. `"all"`, empty strings, and non-string values cannot be pinned. Display pins require an initialized
daemon session and are unsupported in direct mode. The result additively reports
`displayPin` (string or `null` for daemon sessions; omitted on the legacy path).
Pins clear on session release or device rebind, survive observation cache
invalidation, and are not persisted or inherited by a new session.

A pinned role remains that physical role in a closed posture: it never falls
back to cover. A missing panel fails before any capture or input dispatch with
`PinnedDisplayUnavailableError`, naming the pin and the available panels, and
instructing `setActiveDevice {display: null}` (include deviceId and sessionUuid).
If an inventoried panel is not connected on Android or not live on iOS, the
existing display routing refusal becomes the same typed pin error before input
or screenshot dispatch. Inventory/hierarchy probes may be needed to establish
liveness. Action failures carry `error` and
`pinnedDisplay: {pin, availablePanels: [{key, role}]}` in their existing result
channel; observation failures throw the actionable typed error.

When a session has a display pin, an unreadable or degraded display inventory
produces `DisplayInventoryUnavailableError` and asks the caller to retry. The pin
is preserved and no capture or input is dispatched. Actions report `error` plus
`displayInventory: {pin?, retryable: true}`; observation throws the typed error.
Setting a pin also fails with this error if the inventory cannot be read. A
readable inventory that lacks the pinned panel still produces
`PinnedDisplayUnavailableError` with available panels and pin-clearing guidance.

A pin-selected observation stamp adds optional `pinned: true`; explicit selector
calls omit that marker. It describes selection provenance and does not change
panel identity, display generation, or coordinate fences. This shared default
also applies to the display-aware gestures, `hitTest`, `sendKeys`, observation
screenshot captures, and `videoRecording` starts; stopping a recording is permitted even if its panel
has disappeared.

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
`dragAndDrop` uses the same default durations (press 600 ms, drag 300 ms, hold 100 ms) with or without `display`, including the adb fallback for older APKs, which accepts only a drag duration.
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

With `swipeOn({ boomerang: true })`, `apexPause` accepts finite values from
0 to 3000 ms, and `returnSpeed` accepts finite multipliers greater than 0 and
at most 3000. Their defaults remain 100 ms and 1 respectively. The rounded return
duration must be at most 3000 ms, and forward + pause + return must be at most
5000 ms. Both schema and action reject unsafe timing before the forward swipe;
increase `returnSpeed` or shorten the forward duration or pause to fit the budget.
These timing options require `boomerang: true`.

`pinchOn` requires positive `scale`, `distanceStart`, and `distanceEnd` when
supplied; nonpositive values are rejected before gesture dispatch. Its optional
`duration` must be a positive integer from 1 to 10000 ms; the default remains
300 ms. This is a deliberate input tightening: zero, negative, fractional, and
over-10000 ms durations are rejected by both the schema and action.

For `tapOn` and `tapAny` with `action: "longPress"`, `duration` accepts values
from 0 to 60000 ms; zero or omission keeps the platform default. Both the schema
and action reject durations above 60000 ms. When a request deadline is available,
the duration plus 2000 ms dispatch headroom must fit the remaining budget;
otherwise the press is rejected before it starts. If an Android adb long press is
interrupted, its error warns that the press may still be held on the device for
up to the requested duration; wait that duration before retrying touch input.

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
- iPad windowed apps (iOS 27 "Windowed Apps", #6635) are the exception: XCTest
  reports the app and its hierarchy relative to the app window, so `observe`
  reports the window's size as `screenSize` and window-relative bounds. `tapAt`,
  `tapOn`, `swipeOn`, and `dragAndDrop` take points in that window space, and the
  iOS runner adds the window's on-screen origin before it delivers the gesture.
  SpringBoard system alerts shown over the app are reported in the same window
  space, so their bounds can be negative or extend past the window.
  Points outside the window (other apps, the Dock) are not addressable while a
  windowed app is observed. A full-screen screenshot is not offset by the window
  origin; subtract it to compare screenshot pixels with observed bounds.

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

Every returned full-screen fresh (settled or device-read), cached fallback, per-display,
and crop (`crop-*` and `snapshot-of-*`) path is kept for **at least 10 minutes after return** unless capacity pressure evicts it early (below). A flat `<x>Path` has a sibling
`<x>ExpiresAt`: top-level and per-display `screenshotExpiresAt`; objects owning a path have
`expiresAt` (`crop.expiresAt` and snapshotOf's `expiresAt`). These optional numbers are
host-clock epoch milliseconds and are not a promise that the file survives that long.
Returning a cached path again extends its guarantee and recomputes the deadline.

Admission enforces a cap of **128 MiB and 4096 files** for the shared screenshots
directory across all devices and sessions in a process. A new capture is never refused.
When it would exceed either cap, the least recently written or returned screenshots are
evicted, in that order, even inside their guarantee, until it fits. Files no live observe
cache entry or screenshot state references, and not touched in the last 5 seconds, go
first; if they are not enough, eviction continues into referenced and recent files, still
least recently used first, so a returned path (even one a live cache still references) may
no longer exist when a later call uses it. Only a capture's own in-flight write is never
deleted. A single frame larger than the cap is admitted anyway and logged as a warning.
Large-screen devices (iPhone Pro at ~3.3 MB per frame, a foldable's inner panel) reach
128 MiB within one benchmark run, so copy a returned path promptly when a session captures
many large frames. Observations without screenshots are unaffected.
A per-process in-memory inventory tracks capacity. It reconciles with the directory on
periodic or explicit sweeps and near either cap, picking up files from other processes.
Concurrent processes can exceed the aggregate cap before reconciliation; discovered
files count against subsequent admission.
Cleanup failures are logged and retried; retained files whose cleanup failed still count
against admission, so failure cannot allow unbounded growth.

The guarantee is the maximum of the return lease, file mtime plus ten minutes, and
process-start grace. At the first sweep/capture after restart, pre-existing files without
an in-memory lease receive grace through process start plus ten minutes: the previous
process could have returned an old cached path immediately before it crashed. No
persisted index is required. Other processes sharing the directory cannot see local
leases and only honor the ten-minute mtime floor; re-return leases are guaranteed by
the returning process's cleaners, with this cross-process limitation.

Expired, unreferenced files are swept at initial inventory, near capacity, and every
minute on an unref'd host Timer while idle; the idle sweep skips live files. Session
release and device removal only drop cache references: their files remain until expiry and a subsequent
sweep. Abandoned files are recovered after restart and swept when the grace expires.
Copy files needed beyond the reported window; no copy is needed within that window
when using one returning process.

For encoded captures, pass `screenshotOptions` with `screenshot: "settled"`,
`includeScreenshotImage: true`, or `crop`,
for example `observe({ screenshot: "settled", screenshotOptions: { format: "webp", quality: 80 } })`.
Omitting options requests PNG. JPEG and WebP accept integer `quality` from 1 to 100. WebP also accepts `lossless: true`, which cannot be combined with
`quality`; PNG accepts neither. The returned `screenshotFormat`,
`screenshotMimeType`, and `screenshotPath` extension describe the saved bytes
after a platform capture fallback. The path does not depend on reading an
in-protocol screenshot resource. `screenshotImageSize: { width, height }` reports
the full file's raster pixels as written after `screenshotOptions` encoding or
downscaling. `screenshotPixelsPerNativeUnit: { x, y }` reports raster pixels per
native unit, accounting for iOS native-orientation rasters after a quarter turn.
`screenshotScaleProvenance` is `raster-dimensions`, or `native-scale-confirmed`
when the hierarchy's `nativeScale` agrees within 0.02. These fields describe the
file at `screenshotPath`, including a cached fallback, and remain in default
skeleton and diff output. They are omitted when dimensions are unreadable;
incompatible screen/raster aspect ratios retain `screenshotImageSize` but omit
the two scale fields. These best-effort failures log a warning and do not fail
observe. The screenshot's orientation follows the device framebuffer:
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

### Stable automation IDs for Android Views

For legacy Android Views, use the accessibility extra `test-tag` as the stable
per-View automation ID. Set it in an `AccessibilityDelegateCompat` override of
`onInitializeAccessibilityNodeInfo`, after calling `super`:

```kotlin
info.extras.putString("test-tag", "widget_<id>")
```

Keep `contentDescription` as the accessibility-owned label. `observe` exposes the
ID as `testTag` in its searchable output; select it with
`tapOn({ testTag: "widget_<id>" })`. The raw hierarchy field is `test-tag`.

Compose with `testTagsAsResourceId = true` (including the AutoMobile overlay)
reports `Modifier.testTag` as a bare `resource-id` and no `test-tag`. A
`testTag` selector therefore matches nodes by `test-tag` first; only when no
node carries that tag does it match a node without a `test-tag` whose
`resource-id` equals the tag exactly (no `pkg:id/` suffix matching).

Semantic node actions using `testTag`, `uniqueId`, or collection row + column
(with a stable ID) require a CtrlProxy runner that advertises node-action selector
support. Without that support, taps use coordinate routing and long presses use
coordinate input. Ordinary taps already use coordinates; semantic taps are used
for TalkBack activation and eligible DocumentsUI rows. A failed result for an
advertised semantic `long_click` is reported without silent coordinate fallback.
The non-TalkBack long-press path logs a thrown runner error and currently permits
coordinate fallback.

`View.setTag(Object)` and `View.setTag(int, Object)` are not supported automation
IDs: the AccessibilityService client receives `AccessibilityNodeInfo`, not live
Views, so those View tags are never serialized into the observed hierarchy.

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
| 📸 <code>snapshotOf</code>           | Saves a PNG crop of an element or screen rectangle (opt-in).              |
| 👀 <code>observe</code>              | Gets screen hierarchy and screenshot, with optional PNG crop.             |
| 🎯 <code>hitTest</code>              | Estimates hierarchy nodes beneath a coordinate without dispatching input. |
| 🔍 <code>explore</code>              | Explores an app to build a navigation graph.                              |
| 🗺️ <code>navigateTo</code>           | Navigates using the learned navigation graph.                             |
| 📊 <code>getNavigationGraph</code>   | Retrieves the navigation graph for debugging.                             |
| 🔗 <code>identifyInteractions</code> | Suggests likely interactions.                                             |
| 🪟 <code>prototype</code>            | Shows, dismisses, awaits events, or reports overlay prototypes.           |
| 🖍️ <code>highlight</code>            | Draws a visual highlight around a UI element.                             |

### prototype

The `prototype` tool, on Android and iOS simulators (formerly `overlay`, which remains a hidden
deprecated alias for one release) is omitted from discovery by default. Enable it
with `setToolEnabled { toolName: "prototype", enabled: true }`. Its `action` is
`show`, `dismiss`, `status`, `inspect`, or `awaitEvent`. `show` requires a full `spec` (id,
window, optional state, root) and always renders the whole spec. `dismiss`
requires either `id` or `all: true`. `spec.window.opacity` is an integer
percentage from 0 to 100, default 100; show the spec again to change it.

A `show` whose `spec.id` is the overlay already on screen replaces it in place:
it stays on the display it is on, and each pager keeps its current page (matched
by pager id, clamped to the new page count). The new spec's `state` is
authoritative: values the user changed by tapping or typing are not carried
over unless the spec includes them, and the rebuilt tree starts any text field
from the spec's value. `reset: true` starts it fresh instead: pages come from
the spec and `display` is resolved again. A show with a different id, or with
nothing on screen, replaces any other overlay as before. A CtrlProxy that
predates in-place replacement ignores `reset` and always starts fresh.

Two optional window fields need a CtrlProxy advertising
`overlay_window_options_v1`; an older one is refused before anything is sent.
`spec.window.layer` is `system` (default; an accessibility overlay above system
UI) or `app` (an application overlay just above apps, so the notification shade,
keyboard, toasts and the screenshot flash and preview draw over the prototype,
and the status and navigation bars draw over a fullscreen one). Before an `app`
show the daemon runs
`adb shell appops set dev.jasonpearson.automobile.ctrlproxy SYSTEM_ALERT_WINDOW allow`;
if the permission is still missing the device fails the show with that command.
`spec.window.persistence` is `session` (default) or `device`: the overlay stays
interactive after the last host client disconnects (USB unplugged, adb or the
daemon gone) and after session end, has no idle timeout, and keeps its uploaded
assets. `setPage`, `setState`, text fields and the `dismiss` action keep working
offline. It goes away only through its own close control (the fullscreen dismiss
row, or a Close button on sheet and floating windows), an explicit `dismiss`, a
replacing `show`, or the CtrlProxy service stopping. Host-side status and event
buffers are still cleared on session release.

With no host connected, a persisted overlay's events (tap `emit`s, page changes,
text input, a close) are kept on the device, the most recent 200, dropping the
oldest and counting what it dropped. They are delivered, oldest first, when a
host connects or on `inspect`, and sequences continue from the device's ledger
with no rewind. `status` is host memory, so after a session release it shows
nothing; `inspect` asks the device which overlays it is showing and adopts them
(`adopted: true`, with the last known `pages` and `state`), so `status`,
`dismiss` and `awaitEvent` work again. It also returns
`deviceDroppedEvents`. `inspect` needs a CtrlProxy advertising
`overlay_persistence_replay_v1` and is refused with an error naming the flag
otherwise.

The `showVariants` and `update` actions were removed (#10489, #10490); calling
either returns an error naming `show` as the replacement. To present
alternatives, `show` one design, describe it and the others in the conversation
(what each is, what changed between them, which you recommend), and `show` the
next on request. Or `show` one spec whose `pager` holds every design, with a
visible label on each page. Either way, ask the user in chat which they prefer;
never wait on the device for a choice.

Target via `deviceId`, `platform`, `device`, or `sessionUuid`; the shared
`keepScreenAwake` option also applies. `timeoutMs` bounds device requests
(default 5000 ms). Validation uses the existing overlay schema and limits
before contacting CtrlProxy. Verify rendering with `observe`; prototype returns
no screenshot. Nodes include box/row/column, text/image/icon/spacer/textField,
Material switch/checkbox/button/radioGroup/listItem/slider/chip/card/iconButton/fab/segmentedButton/topAppBar/divider/badge/progress/dialog/snackbar/timePicker/datePicker
bound to state keys, and scroll/pager/tabBar/bottomNav/bottomSheet; actions are
emit/setPage/setState/toggle/increment/decrement/dismiss.
A spec may also carry a `theme` (light/dark mode, a seed colour, per-role colour
overrides, typography and shapes), per-node `style` and `styleWhen` fields,
`transition` on `visibleWhen` nodes, and a spec-level `motion` of `none` to make
every change instant. Android also accepts element anchors, which place a node on
an app element resolved at `show` time; the result lists the resolved `anchors`.
See the [overlay vocabulary](design-docs/plat/android/overlay-ux.md).

#### iOS simulators

On iOS simulators `prototype` is backed by an overlay agent injected into the app at launch
(`launchApp { overlay: true }`), with no SDK in the app. It works on simulators only, only for
apps launched with the agent (a relaunch loses app state; SpringBoard is not covered), and
offers `show`, `dismiss`, `status` and `awaitEvent`; showing
the same `id` again updates the overlay. For apps run from Xcode, add `DYLD_INSERT_LIBRARIES`
to the scheme. See the [iOS overlay agent](design-docs/plat/ios/overlay-agent.md).

`show` accepts the same optional `display` selector as the tap tools (a panel
key, a role such as `inner` or `cover`, or `active`), resolved with the same
precedence: an explicit `display`, then the session display pin, then the default
display. Omitting it sends no display and behaves exactly as before. A resolved
non-default display is sent as the panel's logical `displayId` and needs a
CtrlProxy advertising `overlay_display_id_v1`; an older APK is refused with an
error rather than showing the overlay on the default display. An unknown or
disconnected panel is refused with the usual disconnected-panel guidance. If the
panel disappears while the overlay is up (fold), the device dismisses it with
reason `teardown`; it is never moved to another display. `dismiss` acts on the
overlay where it is shown and does not take `display`. A same-id `show` without
`reset` keeps the display the overlay is on: a `display` (explicit or from the
session pin) that resolves elsewhere is ignored, and the result carries a
`warning` saying so; pass `reset: true` to move it.

`display` and `assets` combine on `show`: the display is resolved and checked first, so a
refused display uploads nothing; assets are then uploaded and the overlay is shown on that
display. The one missing-asset re-send goes to the same resolved display without re-reading the
display inventory. A same-id `show` with `assets` stays on the display the overlay is already on.

`show` accepts `assets`: an array of `{ id, path }`
or `{ id, observation }` that uploads images (or, with `path`, TTF/OTF fonts) before the overlay is sent, so no
separate upload step is needed. `path` is an absolute path the daemon can read
(relative paths are rejected); `observation` is an
`automobile:observation/{deviceId}/{observationId}/screenshot` URI (the
`observationScreenshotResourceUri` that `observe` returns) and resolves exactly
as reading that resource does: the observation must still be its device's
current one, a capture still in flight is awaited, and no session ownership is
needed because the resource itself needs none. Each entry has exactly one of
the two. The type is detected from the bytes' signature and must be PNG, JPEG
or WebP, up to 4 MiB per asset, or a TrueType/OpenType font (`.ttf`/`.otf`,
`path` only), up to 2 MiB per font; 16 MiB and 32 assets per call in total, with
unique ids. Image nodes reference an `id` (`image.asset`; nav items use `image`);
`style.fontFamily: {"asset": "<id>"}` references an uploaded font; the spec
never carries paths or bytes. Every file is read and checked first, so an
unreadable file, unsupported format or exceeded cap fails the call with nothing
sent. Uploads then run one at a time. Any failure (a device refusal, an old
CtrlProxy without asset support, a cancelled request, or a write that was never
answered, reported as indeterminate) fails the call before the overlay is shown
or replaced; the error and `uploadedAssets` name the assets already stored, which
stay on the device until the overlay session ends and are replaced if the call is
repeated. On success `uploadedAssets` lists each `{ id, mimeType, bytes }`.

When the device accepts a `show` but lists referenced asset ids it has
no copy of, the result stays successful and adds `missingAssets` (the ids; absent
when none) and a `warning` naming what to upload. If the same call supplied
`assets` for some of those ids (the upload-then-cleared race), they are
re-uploaded from the bytes already read and the overlay re-sent exactly once; the
result is the re-sent one. A retry that fails, or a cancelled request, keeps the
first result and says so in `warning`. The MCP request deadline grows by 15 s per
asset plus the request's `timeoutMs` (default 5000 ms), doubled for that one
retry, plus 10 s per `observation` source for a capture still in flight, and
30 s of headroom.

`status` performs no device request. It reports only overlays successfully
shown by this host in the current session and device, with their last action,
result, and host timestamp in milliseconds, plus the logical `displayId` when a
display was requested. It also returns the last attempted
mutation as `lastResult`, including a failed show without claiming it is shown.
A failed same-id show or dismissal retains known presence. Successful dismissal removes
the id from that device's host records; successful dismiss-all clears that device's entries across host sessions.
After an event arrives, each shown entry also reports `pendingCount`, `lastSequence`
(the highest accepted sequence), and cumulative overflow `droppedCount`. Before any
event, these optional fields are omitted to preserve existing responses.
Each shown entry also includes `pages` (pager id to zero-based page index), flat
`state`, and `lastKnown: true` from its latest accepted `overlay_event`. These
snapshots survive event consumption and failed show attempts; a successful show (same id or not) clears them
until another event arrives. Requested state is never reported as observed state.
Accepted events are pushed once to telemetry under category `overlay`, with
owning device/session ids, event id, kind, name, sequence, pages and state. This
telemetry is push-only, with no database persistence or historical backfill.
A device-side `dismissed` event removes shown presence across that device's host
sessions. `page_changed` events update the last known snapshot and event bookkeeping, preserving host mutation
status. Raw transport disconnects are not observed; session release, device removal,
and device unbinding clear the corresponding buffers and host status.

`awaitEvent` requires `id`; it waits for one event in the current session/device/id
scope. Optional `eventName` (matching `name`), `kind` (`emit`, `page_changed`, or
`dismissed`), and `afterSequence` (a nonnegative integer, strictly exclusive cursor)
are valid only for `awaitEvent`. Its `timeoutMs` defaults to 30000 ms and cannot
exceed 60000 ms; the MCP request deadline for an `awaitEvent` call is that wait plus 30 s of
headroom, so a quiet wait ends with `timedOut: true` rather than a transport timeout. Request cancellation preserves the abort reason and removes the
waiter's timer and abort listener. When the client supplies an MCP progress callback,
wait start/finish notifications are best-effort and do not delay event delivery. Background subscriptions for shown overlays
remain active to buffer events between calls.

The result is `{ success: true, event, pendingCount, lastSequence, droppedCount }`,
with `event` containing `id`, `sequence`, `kind`, `name`, `payload`, `state`, `pages`,
and `timestamp` (device clock milliseconds). If the wait expires, it returns
`success: true, timedOut: true` with counts and no event. If the scope ends without
a matching event, it returns `success: true, reason: "dismissed"` with counts.

The exported `OVERLAY_EVENT_BUFFER_CAPACITY` is 64 events per scope. Overflow drops
the oldest event and increments `droppedCount`; that count is cumulative until
explicit dismiss or scope release. Calls consume one matching event; excluded events
remain pending, including those skipped by a cursor. Accepted events are ordered
by sequence. Lower-or-equal sequences are ignored across reconnects, including
previously unseen late lower arrivals; this implements the wire high-water rule.

Because pushes carry no session id, the latest show of a device/id owns its events;
awaiting that id from another scope is rejected until it is shown in that scope.
Awaiting an unknown id can establish ownership without a show; an unused scope is
removed on timeout/abort. Multiple overlays on a device share one subscription.
Explicit successful dismiss (id or all) clears buffers across that device's host
sessions. Each show, including a same-id show, starts a fresh sequence epoch for that id: pending events and the
sequence high-water mark are cleared (the device's sequence ledger is in memory, so a
CtrlProxy restart restarts a re-shown id at 1), while the cumulative `droppedCount`
is kept until explicit dismiss or scope release. Events carry only id, sequence and
timestamp, so a late event from the previous showing cannot be told apart from the new
showing's and is accepted if it arrives after the new show. A successful show of
another id replaces the device's overlay: the replaced overlay's waiters settle with
`reason: "dismissed"` and its buffers are removed. A terminal `dismissed` event remains
buffered until consumed or the next explicit show/dismiss. Consuming it clears all
remaining pending events and, once no waiter remains, removes the entry, so a later
await behaves as for an unknown id (it waits, then times out). Session release clears
the buffers, waiters and subscription of every scope on each device the release
clears from host status, so event state and status never disagree.
The device subscription ends when no nonterminal overlays remain.

```json
{
  "action": "show",
  "spec": {
    "id": "demo",
    "window": { "placement": { "type": "fullscreen" }, "opacity": 80 },
    "root": { "type": "text", "text": "Hello" }
  }
}
```

### Navigation and highlight options

`explore.timeoutMs` bounds exploration (default 300000 ms); `strategy` is
`breadth-first`, `depth-first`, or `weighted` (default). `mode` is `discover`,
`validate`, or `hybrid` (default), and `packageName` limits exploration to a package.
`getNavigationGraph.appId` scopes the graph to that app instead of the foreground app.

`explore`, `navigateTo`, and `getNavigationGraph` are listed without `--debug`. They remain
off by default and require embedded SDK mode (`--embedded-sdk`).

`identifyInteractions.filter` accepts `types` (`navigation`, `input`, `action`,
`scroll`, `toggle`), `minConfidence` from 0 to 1, and a positive integer `limit`.

`highlight` takes either `shape` (a `circle` with `bounds`) or an `elementId`/`text`
selector, never both. `elementId` is a resource ID; `text` matches text,
content description, or placeholder. `selectionStrategy` is `first` (default),
`random`, or `unique` (ambiguity returns the resolver failure). `container` accepts
a nested chain with per-level `index` and `selectionStrategy`, resolved outermost
first through the same resolver as `tapOn`. `description` labels the highlight,
and `timeoutMs` bounds the highlight request (default 5000 ms).

`explore` accepts positive integer `maxInteractions` (default 200), a positive
`timeoutMs` (default 300000 ms), `resetToHome` to return home
periodically (default false), positive integer `resetInterval` (default 15 interactions), and
`dryRun` to explore without performing interactions.

`navigateTo.targetScreen` names the target screen in the learned graph.
`highlight.containerOf` highlights the selected element's container.
`identifyInteractions.includeContext` controls `navigationGraph` predictions,
`elementDetails`, and `suggestedParams`; each is included unless set to false.

### Android back stack user IDs

`observe.backStack.activities[]` lists activities across Android users/profiles.
Each activity and `currentActivity` includes optional `userId`, the Android
user/profile ID when printed by `dumpsys` (including `0` for the personal user).
`tasks[].userId` comes from the task header. Task IDs are global across users;
`currentTaskId` identifies the foreground task, and `depth` counts that task's
activities minus one. Other users' tasks do not contribute to its depth.

### Observe a booted device by ID

`observe {"deviceId":"emulator-5554"}` returns the normal screen observation,
including hierarchy or skeleton, active window, screen size, display, device lock,
and an available screenshot with its fresh or cached label. With `sessionUuid`,
the call is a session observe, and `deviceId` must match that session's device.

#### Reading a device you do not own (`deviceId`)

A session-less deviceId read may start the hierarchy service on an **unowned**
booted device when its initial connection fails. It uses the session acquisition
setup (including `--skip-ctrl-proxy-download`) within the read's own hierarchy
deadline, serialized with acquisition by the per-device readiness lock. Setup
requires an initialized daemon, an idle device with no session, and no ownership
or pool transition; these conditions are checked before setup and again under
the lock. Concurrent reads share one setup; each reader retains its own wait
deadline and cancellation. The initiating read supplies the shared setup's deadline.

On an **owned** device, a deviceId read never starts, restarts or reconfigures the
service. A disconnected owner client stays connect-only with the recovery detail
below. If ownership cannot be established (including an uninitialized daemon),
the read stays connect-only. No session is created, no device is assigned, and an
unowned device's pool status stays idle. A successful read that participated in
starting the service includes `hierarchyServiceStarted: true`; otherwise that
optional field is omitted. This does not degrade `freshness`.

The started service and its resident singleton client remain running afterwards,
as they do after a session ends. On iOS this includes the manager's runner process.
There is no cleanup or idle teardown in this read path.

Unavailable hierarchies have `freshness.category: "unavailable"`. The table shows
exact `unavailableDetail` templates (`${deviceId}` and `${timeoutMs}` are replaced
with the device ID and connection budget; the default hierarchy budget is 15000ms).
The detail is also appended to `freshness.warning` and limited to 500 characters.

| `unavailableReason`  | `unavailableDetail`                                                                                                                                                                                                                                   | Caller recovery                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_lost`    | `Device ${deviceId} has no reachable hierarchy service`                                                                                                                                                                                               | The read may append why starting the service failed or was declined; retry after the reported ownership/transition or setup problem clears.                                   |
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
shared mappings but never populate or refresh them. Once hierarchy setup is complete or declined, Android observation commands issued
through ADB are read-only (including streamed `screencap`, `dumpsys`, and display
and device-state queries); they do not delay, abort, fail or reorder an ADB-driven
owner action. A read during an action can show intermediate UI: it is not an
atomic snapshot of that action. Hierarchy reads queue behind requests tracked by
the service client, within the hierarchy budget. Android still delivers a changed
observer hierarchy frame through the normal native push path; those ordinary
service updates can update the stream, navigation and display state independently
of observation assembly. An unchanged observer frame skips that path. Reads close any temporary client and release its host port forward/allocation; a
resident client registered by successful readiness setup stays connected.

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

| Tool                          | What it does                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📍 <code>tapAt</code>         | Taps screen coordinates or a point measured in an observation image; supports long press and double tap.                                                    |
| 👆 <code>tapOn</code>         | Taps by text, content description, resource ID, or Android test tag; supports nested containers and first/random/unique selection; can ensure toggle state. |
| 🎯 <code>tapAny</code>        | Taps any clickable element, optionally scoped to nested containers; supports first/random/unique selection.                                                 |
| 👉 <code>swipeOn</code>       | Swipes or scrolls the screen or an element; container and lookFor support nested scopes and first/random/unique selection.                                  |
| ↔️ <code>dragAndDrop</code>   | Drags one element to another; each endpoint supports nested containers and first/random/unique selection.                                                   |
| 🤏 <code>pinchOn</code>       | Pinches to zoom, optionally scoped by nested containers.                                                                                                    |
| ⌨️ <code>sendKeys</code>      | Runs ordered text, clear, raw-key, and semantic-key commands.                                                                                               |
| 🧩 <code>setUIState</code>    | Sets multiple form fields to a desired state.                                                                                                               |
| ✨ <code>selectAllText</code> | Selects all text in the focused input.                                                                                                                      |
| 🔘 <code>pressButton</code>   | Presses a device or navigation button. iOS simulators support volume and power; iOS does not support menu.                                                  |
| ⌨️ <code>keyboard</code>      | Opens, closes, or detects the keyboard; selects AutoMobile profiles or installed Android IMEs.                                                              |
| 📋 <code>clipboard</code>     | Copies, pastes, clears, or reads the clipboard.                                                                                                             |

### Tap, swipe, and form search options

`tapOn.searchUntil` polls for the element before tapping; its optional `duration`
is 100–12000 ms (default 1500). `preTapStability` requires stable bounds before
tapping, and `retryIfNoChange` retries once when the hierarchy is unchanged after
a tap. `ensureTap` enables both checks. Direct semantic-link activation cannot
use `searchUntil`.

`tapAny.searchUntil` polls for an eligible clickable element with the same
`duration` range and default. `scrollableContainer` restricts its search to
scrollable containers/lists.

`swipeOn.gestureType` chooses whether `direction` describes finger movement
(`swipeFingerTowardsDirection`, the default) or content scrolling
(`scrollTowardsDirection`). `setUIState.scrollDirection` sets the initial
search scroll direction.

A successful `swipeOn` that can compare the screen before and after reports
`navigated`. `navigated: true` means the screen identity changed, so the swipe
probably acted as a tap and opened the row under it instead of scrolling, and
`warning` says so; `navigated: false` means the screen is the same. The field is
absent when the two observations carry no comparable screen identity.

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

`tapOn` and `tapAny` accept recursive `container` selectors. The outermost
container resolves first; every inner container and the target must be strict
descendants of the previous level, including across anonymous wrappers:

```json
{
  "selector": { "elementId": "remove" },
  "container": {
    "elementId": "item_42",
    "container": { "elementId": "cart_A" }
  },
  "selectionStrategy": "unique"
}
```

For `tapAny`, omit `selector` to select any eligible clickable descendant.
Like `tapOn`, `tapAny` accepts `display` (panel key, role, or `active`); an omitted
value uses the session display pin when present. Android selection, polling,
retry, and input stay on that panel; iOS requires the live panel. Explicit panel
targeting requires a prior observation of that panel, as with `tapOn`.
The default remains `first`; `random` keeps its existing behavior. `unique`
requires exactly one eligible target and exactly one match at every unindexed
container level, even when that level specifies `first` or `random`. A
container's explicit zero-based `index` selects within that level's scoped
candidate set; `tapOn.index` similarly overrides leaf uniqueness. Missing or
ambiguous levels fail without a tap or a global fallback. Errors name the
container level (outermost is 1) or target and show up to five ambiguity
candidates with resource IDs, text, and bounds.

For ordered `textAny` selectors, `unique` skips missing text variants within the
same scope, but fails immediately on an ambiguous variant or container.

`unique` supports `ensureChecked` and owner-scoped `subtext`. It cannot combine
with `sibling` or direct `accessibilityLink`; select a unique owner with
`subtext` for semantic links. The existing random/subtext and indexed-owner
restrictions still apply. Nested or unique taps use the selected coordinates or
bounds for native dispatch instead of a global resource-ID lookup. With iOS
VoiceOver enabled, such `tapAny` calls require a label for activation at the
selected bounds; an ID-only target fails without an action.

`dragAndDrop.source` and `dragAndDrop.target` each accept exactly one of
`elementId` or `text`, plus their own optional recursive `container` and
`selectionStrategy` (`first`, `random`, or `unique`; default `first`):

```json
{
  "source": {
    "elementId": "remove",
    "container": {
      "elementId": "item_42",
      "container": { "elementId": "cart_A" }
    },
    "selectionStrategy": "unique"
  },
  "target": { "elementId": "cart_B" }
}
```

Both endpoints resolve independently before any drag starts. The same outermost
first scope rules and container indices apply. `unique` requires one eligible
leaf and one match at every unindexed container level. Missing or ambiguous
scopes and leaves fail without a drag or global fallback; errors identify
`source` or `target`, retain the container level or target failure, and list
ambiguity candidates. Scoped and unscoped endpoints can be mixed. These fields
belong inside each endpoint, not at the top level; unknown endpoint keys and
malformed recursive containers are rejected.

#### Hierarchy layer

`observe`, `tapOn`, `tapAny`, `sendKeys`, `highlight`, `dragAndDrop`, `swipeOn`,
`pinchOn`, `tapAt`, `selectAllText`, and `identifyInteractions` accept an optional top-level `layer`
(`"app"` or `"overlay"`) that scopes the call to one layer of the screen. `app`
excludes AutoMobile's own overlay window; `overlay` keeps only overlay nodes and
fails with an actionable error when no overlay is showing. Omit it to search both,
topmost first. `observe` applies it to the returned hierarchy and to `waitFor`
element conditions. `identifyInteractions.layer` analyzes only that layer's
elements. `dragAndDrop.layer` scopes both the `source` and the `target`
drop-target resolution; `swipeOn.layer` scopes `container`, auto-target, and
`lookFor` resolution; `pinchOn.layer` scopes `container` and auto-target resolution.
With `layer: "app"`, an Android CtrlProxy that advertises
`screenshot_hide_overlay_v1` hides its overlay for the `observe` capture: it hides
the window, waits for a rendered frame, captures and restores, all on the device in
one request, so a cancelled observe never leaves the overlay hidden. While an
overlay is showing, the result then reports `screenshotIncludesOverlay: false`; a
capture that cannot confirm the hide fails instead of falling back to ADB. Older
CtrlProxy builds, iOS, and `deviceId` reads (which capture through ADB) still
include the overlay in the screenshot or crop, and the result says so with
`screenshotIncludesOverlay: true`. Navigation-graph
screen identity always uses the app's windows only, so showing, paging, or
dismissing an overlay records no navigation.

Touches go to the window under the point where a finger goes down, so gestures
are checked there before dispatch: the tap point (`tapAt`, `tapOn`, `tapAny`), the
swipe start (`swipeOn`), both finger start points (`pinchOn`), and both drag
endpoints (`dragAndDrop`). With `layer: "app"` a gesture whose point lies under an
overlay window is refused. With `layer: "overlay"`, `tapAt`, `swipeOn`, and
`pinchOn` also refuse a point outside every overlay window, because it would
reach the app. There is no touch-through mode: hide or move the overlay to reach
the app beneath it.
`selectAllText` acts on the input-focused field and is refused when that field is
on the other layer. `layer` on `sendKeys` and `highlight` requires a selector,
`tapOn` rejects it together with `accessibilityLink` or `subtext`, and `swipeOn`
rejects it together with `display`.

`swipeOn.container` identifies the element to swipe within and accepts the same
recursive container, per-level index, and selectionStrategy fields. `lookFor`
accepts exactly one of `elementId` or `text`, plus its own recursive `container`
and `selectionStrategy` (`first`, `random`, or `unique`; default `first`):

```json
{
  "direction": "up",
  "container": {
    "elementId": "list",
    "container": { "elementId": "panel_A" },
    "selectionStrategy": "unique"
  },
  "lookFor": {
    "text": "Target",
    "container": { "elementId": "section" },
    "selectionStrategy": "unique"
  }
}
```

The swipe container resolves before dispatch. A plain one-level container and
unscoped lookFor keep their existing behaviour, including falling back to an
auto-detected scrollable when the container misses during scroll-until-visible.
Nested chains, selectionStrategy, or container index opt into scoped resolution:
a swipe container miss or ambiguity fails before a gesture without automatic or
global fallback. The outermost lookFor scope resolves within the swipe container,
and every later level and leaf uses strict ancestry, traversing anonymous wrappers
and allowing inert containers. With a scoped lookFor and a legacy swipe container,
the swipe container keeps its existing fallback behaviour and constrains the
lookFor chain only when it actually resolves in that observation. The complete
scope is re-resolved on each search observation within the existing scroll budget. Missing lookFor scopes or targets remain scoped
while scrolling and report a not-found error naming the scope; another list's
match never satisfies the search. `unique` rejects ambiguity at every unindexed
scope and the target, listing candidates before another gesture. A unique
zero-match target keeps searching within the budget. Random scope selection is
bound to the selected swipe container for each observation. Strategy fields
belong inside `container` or `lookFor`; a strategy without a selector and
malformed recursive selectors are rejected. Existing screen and simple selector
calls retain their defaults.

`waitFor` accepts nested container scopes. This nested-scoping contract is not yet
available for `observe` subtree queries.

`pinchOn.container` accepts nested containers with per-level `index` and
`selectionStrategy` (`first`, `random`, or `unique`; default `first`). Strategy
selection is supported only inside each container level; `pinchOn` has no
top-level `selectionStrategy`.

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

`sendKeys.container` accepts the same nested chain: the outermost scope resolves
first, then each inner container and the field resolve among strict descendants
of their immediate scope, across anonymous wrappers. Each container may specify
a zero-based `index` within its own scoped candidate set. `selectionStrategy`
accepts `first` (default), `random`, or `unique`; `unique` requires exactly one
eligible field and one match at every unindexed container level, even if a level
specifies another strategy. There is no top-level field index.

Both `container` and `selectionStrategy` require a `selector` naming the field
to focus. The field is focused once before any command, including `clear` and
IME keys, on the requested display when supplied. Missing, ambiguous, or stale
targets fail without executing any commands or falling back to a global match
or an unrelated focused field. Resolver errors distinguish missing containers,
missing fields within the container, and ambiguous containers or fields, with
up to five ambiguity candidates including resource IDs, text, and bounds.

```json
{
  "selector": { "elementId": "quantity" },
  "container": {
    "elementId": "item_42",
    "container": { "elementId": "cart_A" }
  },
  "selectionStrategy": "unique",
  "commands": [{ "action": "type", "text": "3" }]
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
standalone `{ "action": "clear" }` command clears the focused field. On Android
its default (`auto`) and `ime` modes clear through the CtrlProxy IME
(`ime_clear_field_v1`), or with key-event deletes on an older APK or when the
IME cannot be activated, so a
rich-text editor keeps its live formatting; only `mode: "a11y"` uses the
accessibility `ACTION_SET_TEXT` clear. Execution
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

### Semantic accessibility links

For iOS `tapOn.accessibilityLink` and `tapOn.subtext`, `occurrence` is the
zero-based index among links with the requested text (case-insensitive) within
the owning text element. `subtext` uses the resolved text element as its owner;
`accessibilityLink` with `container` uses that container's owner identity.

Without an owner, iOS selects the first element carrying a matching semantic
link in document order, then resolves `occurrence` within that element. This
changes the previous tree-wide counting (#6631). It never skips to a later owner
when the first lacks the occurrence or link geometry. With multiple candidate
owners, a successful SDK activation adds the runner's note to the result's `warnings`, naming the
selected owner and candidate count; use `container`/`subtext` for a specific owner.

When SDK resolution fails, the XCUITest fallback remains available. Its flat
links query has no owner grouping, so owner-less `occurrence > 0` is refused
with an error asking for `container`/`subtext`. Owner-less occurrence 0 activates
the first label-matching hittable link. Owner-scoped fallback indexes matching
links within the owner's link descendants, including the owner itself if a link.
Android is unchanged: matching links count in document order within the owner's
subtree, or the whole active-window tree when owner-less.

## Apps, files & app data

| Tool                                                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📱 <code>listApps</code>                                                                         | Lists installed apps with optional label/launchability when reported (`device`, `type`, `search`, `profile`; default `type=launchable`).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 🚀 <code>launchApp</code>                                                                        | Launches an app by package name. On iOS, optional `launchArguments` start a fresh process and pass argv after the bundle ID. DEBUG storage writes require a launch-scoped mutation token; the daemon supplies it when `--allow-storage-mutations` is present. Android rejects non-empty launch arguments; an app already in the foreground is a success flagged `alreadyForeground`. On iOS simulators, `overlay: true` relaunches the app with the overlay agent injected (state is lost); physical iOS, Android and `com.apple.*` apps reject it.                                       |
| ❌ <code>terminateApp</code>                                                                     | Terminates an app by package name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 💥 <code>crashApp</code>                                                                         | Intentionally crashes a running app through the platform crash path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ♻️ <code>appLifecycle</code>                                                                     | State-preserving background-process kill for saved-state restoration tests (Android only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 📦 <code>installApp</code>                                                                       | Installs an APK, app bundle, or IPA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🗑️ <code>uninstallApp</code>                                                                     | Uninstalls an app by package name or bundle identifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🔗 <code>getDeepLinks</code>                                                                     | Queries an app's deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 📄 <code>putAppFile</code>                                                                       | Writes local-file, UTF-8, or base64 fixtures through one target/files contract: private app_containers, bounded platform-qualified user_files, or media_library. Default-enabled for every storage target; see the canonical call shape below.                                                                                                                                                                                                                                                                                                                                            |
| 🧾 <code>resetAppLogs</code>                                                                     | Resets explicitly named app-container log files and their rotated siblings on the session device, with per-path outcomes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📁 <code>stageSessionDownloads</code>                                                            | Deprecated session-bound alias of putAppFile target.domain user_files (Android Downloads); retains session ownership checks and remains until equivalent workflows are device-verified.                                                                                                                                                                                                                                                                                                                                                                                                   |
| ⚙️ <code>getPreference</code> / ⚙️ <code>setPreference</code>                                    | Reads or writes Android system properties, SharedPreferences, or iOS UserDefaults. On iOS, requires `appId` and selects the store with `suite` (not `name`/`fileName`); omitted/`Standard` uses the default store. Uses an already connected embedded SDK, with simulator plist fallback when permitted.                                                                                                                                                                                                                                                                                  |
| 🔑 <code>setKeyValue</code> / 🔑 <code>removeKeyValue</code> / 🔑 <code>clearKeyValueFile</code> | Manages an app key-value storage file. For iOS, an empty `name`, "standard" (any case), or the app bundle id selects standard UserDefaults; other names select a valid suite. Names must have no leading or trailing whitespace. Android uses a SharedPreferences file name without `.xml`. iOS write results include `resolvedStore` when supported by the SDK and runner. `setKeyValue` returns `effectiveValueDiffers: true` and appends a warning when the write persisted but the app reads a different effective value due to an override; remove/clear never produce this warning. |
| 🗃️ <code>listDataStores</code> / 🗃️ <code>getDataStore</code>                                    | Lists or reads Android Jetpack DataStore entries with the SDK adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🗄️ <code>sqlQuery</code>                                                                         | Executes SQL against an app SQLite database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔐 <code>resetKeychain</code>                                                                    | Resets all Keychain data on an iOS Simulator after explicit confirmation; unsupported on Android and physical iOS devices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

<details class="note" markdown="1">
<summary>State-preserving app lifecycle contract</summary>

<code>appLifecycle</code> is the state-preserving kill for saved-state restoration
tests. Call it with <code>appId</code> and <code>action: "background"</code>, then
<code>action: "killBackgrounded"</code>, and relaunch with <code>launchApp</code>.
A foreground app is refused by <code>killBackgrounded</code>: background it first.
An already backgrounded app does not receive a Home press.

<code>processReclaimed</code> is true only from PID evidence: the old PID must be
gone from all package-owned processes in the selected Android user. A restarted
process still counts as reclaimed; <code>pidAfter</code> reports the new main PID,
or null when none exists. A not-reclaimed result is not an error: Android only
kills processes it considers safe to kill. Failed process-table reads cannot
prove reclaim and return an unverified advisory message if no poll succeeds.

<code>terminateApp</code> is the force-stop (discards saved state);
<code>crashApp</code> is the hard crash. This tool supports Android only; iOS
returns <code>supported: false</code> for both actions because no state-preserving
termination/PID contract is verified. Use <code>homeScreen</code> for iOS Home.

</details>

### App launch, installation, links, and storage options

`openLink.url` is the URL to open. `getAppPermissions`, `getDeepLinks`,
`getNotificationPolicy`, `clearKeyValueFile`, and `removeKeyValue` use `appId` for
the Android package name or iOS bundle ID. `clearKeyValueFile.fileName` and
`removeKeyValue.fileName` are deprecated aliases for the store selector `name`.
`setAppPermissions.action` selects `grant`, `revoke`, or `reset`.

`resetKeychain` requires `appId` and `confirm: true`. On iOS Simulator the reset
erases every app's Keychain, regardless of `appId`.

`launchApp.coldBoot` starts the app cold instead of resuming it (default false).
`installApp.artifactPath` is the host path to an `.apk`, `.app`, or `.ipa`.
`uninstallApp.keepData` retains app data after uninstall on Android (default
false; Android only).

`openLink.acceptOpenAlert` automatically taps Open on an iOS system
"Open in <app>?" alert. On Android, `chooserAppPackage` selects the exact package
when opening the URL displays an intent chooser.

`sqlQuery.databasePath` selects the database path; for iOS SDK databases, use the
absolute registered path reported by the App Databases resource. On Android,
`sqlQuery` rows and the table-data resource return integers within ±(2^53 - 1) as
JSON numbers; an integer outside that range is returned as its exact decimal
string, and the response lists the zero-based columns that hold such strings in
`bigIntegerColumns` so they can be told apart from TEXT.
`getDataStore.adapterName` and `listDataStores.adapterName` select the name under
which the host app registered its AutoMobile SDK DataStore adapter.

`setAppPermissions.notificationsEnabled` controls Android notification state
independently of `POST_NOTIFICATIONS`. `notificationPolicyAccess` sets Android
Do Not Disturb policy access, and `scheduleExactAlarm` sets the
`SCHEDULE_EXACT_ALARM` appop to `allow` or `deny`.
`setNotificationPolicy.policyAccess` likewise controls Android DND policy access.

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

**Breaking change:** `stageSharedStorage` and `stageSharedStorageFixtures` have been removed.
Replace either call with default-enabled `putAppFile`:

```json
{
  "name": "putAppFile",
  "arguments": {
    "target": {
      "domain": "user_files",
      "namespace": "fixtures",
      "reset": false,
      "indexMedia": true
    },
    "files": [{ "destinationPath": "fixture.txt", "contentText": "fixture" }]
  }
}
```

Move `namespace`, `reset`, and `indexMedia` into `target`; keep `files` and device/session
options at the top level. Each file requires `destinationPath` and exactly one of
`sourcePath`, `contentText`, or `contentBase64`. Set `indexMedia: true` to preserve the
removed tools' Android indexing default; `putAppFile` defaults it to false.

Every target uses `target` plus a non-empty `files` array. Each file has a
normalized relative `destinationPath` and exactly one of `sourcePath`,
`contentText`, or `contentBase64`. Device selection uses the existing `platform`,
`deviceId`, or `sessionUuid` fields. Optional `userId` selects an Android profile.

`putAppFile` never terminates the app. After a successful `app_containers` write,
`result.warning` appears when the target app is known to be running (on Android,
in the written user profile): it may not see the change until it re-reads the file
or is relaunched. The warning is omitted when running state is unknown or the
app is not running, and for `user_files` and `media_library` writes.

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

iOS Simulator `user_files` uses the managed fixture app
`dev.jasonpearson.automobile.FilesFixture`, which is **not yet shipped in this
repo**. Install it before writing; missing-container resolution returns install
guidance without a fallback or auto-install. The provider resolves its data
container with `simctl get_app_container` and stages only
`Documents/automobile/<namespace>/<relative destination>`; reset removes only
that namespace. `host_stage: completed` confirms the copy, while
`document_picker: unavailable` remains the default unless a verifier observes
the exact destination. Physical iOS is unsupported without a future on-device
fixture-app integration. There is no iOS `user_files` list/read resource.

The accepted design records a picker experiment on iPhone 15 Pro Simulator,
iOS 17.5, Xcode 26.3 (2026-08-28). This provider is unit-tested with fakes;
the managed fixture app and production picker verification need a follow-up.
See [the accepted design](decisions/ios-user-files-provider.md).

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
provider. user_files writes support Android Downloads and iOS Simulator managed
fixture-app namespaces; user_files list/read resources remain Android-only.
Media libraries have no list/read resource.
Use `sdk/capabilities` to read the app SDK's capability states and capture policy
(see [SDK capabilities](using/sdk-capabilities.md)). Use `storage/capabilities` for
provider-derived operations and prerequisite states;
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
callable. `putAppFile` is default-enabled for app_containers, user_files, and
media_library. All domains resolve only its session override, then startup default,
then registration default. An explicit false override disables all three target
policies. Stored overrides under removed tool names are ignored without migration
or deletion. `stageSessionDownloads` stays default-disabled with its separate
session-bound policy and does not grant unified target enablement. No new MCP call
gate is introduced.

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

Devicectl-only simulator features such as orientation, per-display screenshots, and Duo hinge/active-panel support are Planned (#8349, #8350, #8351) and will require CoreDevice >= 651. No current tool is gated on CoreDevice version. The lazy production probe checks boot state before devicectl and memoizes captured unsupported feature IDs; doctor and `automobile:host/toolchain` retain the bounded `devicectl --version` read and seed the injected probe, alongside simulator boot counts and observed capabilities. Capability state stays "not probed" until a real command runs; the downgrade guard is out of scope per the owner decision on 2026-10-02 and is not reported. The CoreDevice doctor result includes the summary in its optional `detail` string, which the console prints on an indented line below the version for every check status. JSON retains the existing fields and adds `detail`. See the [iOS simctl and devicectl boundary design](design-docs/plat/ios/simctl-devicectl-boundary.md).

| Tool                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📋 <code>listDevices</code>                                                    | Lists booted devices using the shared device description: identity, runtime, form factor, lifecycle, and session summary; a note points to MCP resources for image detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🖼️ <code>listDeviceImages</code>                                               | Lists configured images using the same canonical identity, runtime, display, lifecycle, provenance, and capability inventory shape as the images resource.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🤖 <code>getAndroid</code> / 🍎 <code>getApple</code>                          | Finds or recovers an Android AVD or iOS Simulator for automation; Android identity includes API level and OS version when known.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🧱 <code>provisionDevice</code>                                                | Provisions an exact virtual-device identity, with optional resource configuration before automation readiness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ⚙️ <code>setDeviceResources</code>                                             | Configures selected device resources and returns verified, unsupported, or unknown state; omitted settings stay unchanged. Omitted from discovery by default: select it with `setToolEnabled` (case-sensitive `setDeviceResources`) or `--enable-tool setDeviceResources`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 🧭 <code>reconcileDeviceResources</code>                                       | Compares an iOS Simulator with a requested resource map (workload profile) and reports typed drift: `missingRequested`, `ownedExtra`, `unsupported`, `commandFailure`. Report-only by default; `repair: true` applies only the drifted delta, re-reads, and fails closed. Omitted from discovery by default: select it with `setToolEnabled` (case-sensitive `reconcileDeviceResources`) or `--enable-tool reconcileDeviceResources`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🔧 <code>setActiveDevice</code>                                                | Sets the active device. Optional session `display` pins a panel key/role; `null` clears, omission preserves. Explicit display beats pin, then focus/posture. Pins clear on release/rebind; direct mode unsupported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ❌ <code>killDevice</code> / 🧹 <code>deleteDevice</code>                      | Stops a device, or stops and permanently deletes it. Both accept `force: true`, which drops every AVD-name comparison for a wedged Android emulator — the emulator-console confirmation and the platform kill's own re-discovery check — and acts on whatever occupies the serial; it does not bypass serial selection, nor the refusals raised when the pooled entry was retired and replaced mid-action, or when no booted target can be identified at all. Both also refuse a device another session holds (`device_owned_by_other_session`) unless the caller is the holder; `force: true` overrides that refusal on any platform. See [Device ownership](using/device-ownership.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 📸 <code>deviceSnapshot</code>                                                 | Captures or restores a device snapshot. Android VM restores in daemon mode return the new deviceSessionUuid and supersede the previous device-session epoch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🔄 <code>rotate</code>                                                         | Changes device orientation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 📖 <code>setPosture</code>                                                     | Sets a supported posture or a BEST EFFORT hingeAngle (0-180 degrees, emulator/simulator only). Exactly one selector is required; angle requests cannot use displayPreset. Unsupported angles return status: "unsupported" with a reason and no state change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🌐 <code>openLink</code>                                                       | Opens web URLs or routes app and universal deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🧰 <code>homeScreen</code> / <code>recentApps</code> / <code>systemTray</code> | Controls core system surfaces and notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🔓 <code>wakeAndUnlock</code>                                                  | Wakes and unlocks the keyguard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 🌍 <code>changeLocalization</code>                                             | Changes locale, time zone, text direction, time format, and calendar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ⚙️ <code>getDeviceState</code> / ⚙️ <code>setDeviceState</code>                | Reads or changes Do Not Disturb, simulator biometric enrollment, network condition, and static geolocation. Set a point with `location: { mode: "static", latitude: 37.7749, longitude: -122.4194 }` on an Android emulator or iOS Simulator. Latitude must be within −90..90 and longitude within −180..180. The result echoes the applied coordinate; location read-back is unavailable, and physical devices return an unsupported error. On release or rebind of a session that set a location, iOS Simulator clears it with `simctl location clear`; failed clears are retried and quarantine the device until success or removal. Android emulator fixes persist after the session because the emulator console has no unset command; reset the fix explicitly if needed. Direct-mode (sessionless) calls are unchanged. A sessionless fix written while a session marker remains on that device is cleared by that session's release; markers are per device and session, not per write. `getDeviceState` also reads back the Android connectivity toggles — `airplaneMode`, `wifiEnabled`, `bluetoothEnabled`, `locationEnabled` — in a single adb round-trip, so a toggle can be checked before it is flipped; a bare call returns `doNotDisturb` + `connectivity`, and `include` selects any subset. A connectivity field is `true`/`false`, or omitted when the device could not answer it (key absent on this API level, or an unparsable value) — omitted never means off. Connectivity is unsupported on iOS: Airplane mode, Wi-Fi, Bluetooth and Location have no simctl/devicectl read verb, and a simulator shares the host's network stack. Degraded profiles — including `offline` — are best-effort cellular shaping on an Android emulator (`adb emu network …`/`gsm data off` plus a best-effort Wi-Fi disable), reported `partial`: they may not affect Wi-Fi or app traffic. Only reset to `none` is fully verified. A session restores the network to a clean `none` state on release. Network shaping is unsupported on physical Android and all iOS. |
| 🔠 <code>displayConfig</code>                                                  | Reads or sets font/text scale, effective display density, and light/dark theme for adaptive-layout and large-font accessibility testing. Android supports all three fields (density overrides are best-effort on physical devices); the iOS Simulator supports theme only, via `simctl ui appearance`; physical iOS is unsupported. Android reset restores font scale and density to device defaults and restores night mode only to the value displayConfig replaced earlier in this process; otherwise night mode is left unchanged. Android reset never forces light. Omitted from discovery by default — select it with `setToolEnabled` (case-sensitive `displayConfig`) or `--enable-tool displayConfig`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🧬 <code>getIosSimulatorCapabilities</code>                                    | Discovers biometrics for a selected iOS Simulator device type and runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 🫆 <code>biometricAuth</code>                                                  | Simulates biometric authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 📳 <code>shake</code>                                                          | Shakes an Android emulator or iOS Simulator; duration must be an integer from 1 to 1,798,000 ms, and Android intensity must be from 1 to 1,000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📞 <code>phoneCall</code> / 💬 <code>sendSms</code>                            | Simulates an incoming call or SMS: Android emulator console, or CallKit and a notification through the app's AutoMobile iOS SDK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🔔 <code>postNotification</code>                                               | Posts a notification through Android SDK hooks or iOS Simulator push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🔔 <code>getNotificationPolicy</code> / 🔔 <code>setNotificationPolicy</code>  | Reads or changes app notification and Do Not Disturb policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🛂 <code>getAppPermissions</code> / 🛂 <code>setAppPermissions</code>          | Reads or changes app permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Clock control uses `setDeviceState` with `clock: { mode: "set", instant: "2026-10-01T00:00:00Z" }`, `clock: { mode: "advance", byMs: 60000 }`, or `clock: { mode: "reset" }`. Set requires ISO-8601 with Z or an explicit offset within **2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z, inclusive** (`MIN_DEVICE_CLOCK_INSTANT_MS` / `MAX_DEVICE_CLOCK_INSTANT_MS`). Advance requires an integer `byMs >= 1000`, at most `MAX_DEVICE_CLOCK_ADVANCE_MS` (315360000000, ten 365-day years). An early device read rejects cumulative targets outside that window before any clock or other field mutation. Immediately before the clock write, after other requested fields, root acquisition and disabling automatic time, advance reads the device again and range-checks the fresh target. A target that leaves the window during those operations returns a typed clock-field failure; other fields retain their results. Read-only root-capability probes and `date +%s` may run during validation. All inputs are validated before applying any field. Only rootable Android emulators support writes; Play Store images, physical Android devices, and all iOS targets return unsupported. Changing the clock affects TLS/certificate validation, token expiry, and the daemon's own freshness checks for that device.

Set/advance disable automatic time. Results report `instant`, `automaticTime`, `requestedInstant`, `appliedInstant`, `readBack`, `verified`, and `toleranceMs` (2000). Commands have **second-level precision**, truncating milliseconds. Advance verifies at least the requested whole seconds minus tolerance, with a minimum one-second movement; a no-op is never verified. Set within tolerance of current device time reports distinct `outcome: "unchanged"`, without writing clock state. Every clock change (set/advance/reset and lifecycle restore, including potentially partially applied failures) invalidates hierarchy/observe caches and freshness baselines so backward jumps cannot reuse stale hierarchies.

At the first mutation, a session records original `auto_time`, ownership of the clock change, and whether AutoMobile rooted adbd. On **session release/rebind/device teardown/reset**, AutoMobile explicitly steps the clock to **HOST-derived real time** (injected host Timer), restores original `auto_time`, and verifies both by read-back, including when original `auto_time=1` because emulators may never automatically re-sync. A failed restore retains pending ownership and retries; the device stays quarantined until restoration succeeds or the device is removed. Each command and the initial teardown wait are bounded; retries use the existing network restore delay (250ms) and pending-device-cleanup pool quarantine, continuing past its bounded retry batch. Reset clears the slot only after verification.

Clock control can **restart adbd on the emulator**; connections such as port forwards may be re-established. It probes `shell id` before rooting and unroots on restore only if AutoMobile rooted it, using bounded `unroot` / `wait-for-device` commands. Unroot failure is logged and best-effort, and does not fail verified clock/auto-time restoration. The existing legacy locale root path likewise waits for ADB and verifies root, with no explicit port-forward/CtrlProxy reconnect step.

The restore slot is **in memory only**: daemon restart loses it, potentially leaving a wrong clock and `auto_time=0`. `reset` is the recovery: with no recorded slot on a rootable emulator, it writes HOST time and `auto_time=1`. Reset checks target support and recorded ownership before root capability. Physical Android and iOS get no root/clock commands; without a slot, a root-refusing Play Store image reports unsupported/"nothing to reset" with no clock mutations. With a slot, refused root reports a typed failure and keeps restoration pending. Session-bound and sessionless clock mutations serialize through one device queue and inherit one original `auto_time` and root-ownership baseline, in either calling order. Session release still restores host time and original `auto_time`; a sessionless claim retains the original baseline until explicit reset or device removal. Removal aborts queued and in-flight clock commands for that device incarnation. Direct/sessionless mode retains original `auto_time` and root ownership per device until explicit reset or device removal; it has no automatic lifecycle restore, so callers must reset explicitly. Operational clock failures are typed per-field failures (`verified:false`) and do not lose other fields' results or prevent a successfully applied network condition's TTL from being armed.

`getDeviceState` with `include: ["clock"]` reads current Android instant and automatic time without root, including physical devices and non-rootable images; iOS reports unsupported. The default read selection remains Do Not Disturb and connectivity.

Camera posters use `setDeviceState` with `cameraPoster: { mode: "image", path: "/abs/poster.png" }`, `cameraPoster: { mode: "qr", text: "payload" }`, or `cameraPoster: { mode: "clear" }`, plus an optional `surface` of `wall` (default) or `table`. It runs `adb -s <serial> emu virtualscene-image <surface> [path]` on a **running** Android emulator, with no gRPC client and no cold restart; QR payloads reuse the `startDevice` `cameraPosterQr` poster writer. The path must be a PNG/JPG/JPEG that exists and contains no whitespace (the console splits on spaces). The AVD back camera must be `virtualscene`: boot it with `startDevice` `cameraPosterPath` or `cameraPosterQr`, otherwise the console refuses and the error is returned with that hint. iOS and physical Android return unsupported. The console answering `OK` does not confirm the camera shows the poster: the virtual scene's default camera pose may not face it, and nothing reads the camera frame back, so the result carries a `warning` instead of `verified`. The poster persists until cleared or the AVD is cold-booted.

Location route playback uses `setDeviceState` with `location: { mode: "route", waypoints: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }], durationMs: 10000 }`. Provide exactly one of positive, finite `durationMs` or `speedMetersPerSecond`. A route needs at least two ordered waypoints; latitude is −90..90, longitude is −180..180, and optional altitude is finite. `loop` defaults to false; `updateIntervalMs` defaults to 1000 and accepts integers from 200 to 60000. Starting a route returns immediately with its waypoint count, total distance, expected duration, loop, interval, and method. iOS Simulator interpolates on the host and sends repeated `simctl location set` commands. Three consecutive fix failures stop playback and are logged; the next location write reports the failed route in `previousRoute` with `endedReason: "failed"` and `lastError`.

One route runs per device. A static fix, new route, `location: { mode: "stop" }`, session release, unbind, or device removal cancels it. On release or rebind of a session that set a location, iOS Simulator clears it with `simctl location clear`; failed clears are retried and quarantine the device until success or removal. Android emulator fixes persist after the session because the emulator console has no unset command; reset the fix explicitly if needed. Direct-mode (sessionless) calls are unchanged. A sessionless fix written while a session marker remains on that device is cleared by that session's release; markers are per device and session, not per write. Stop reports `stopped: false` when idle and `previousRoute` when a route ended, including its `endedReason` (`completed`, `failed`, `replaced`, or `stopped`) and any `lastError`.

During canonical-shape phase 1, every device surface returns the complete shared description:
static facts are top-level, changing state is under `runtime`, and the previous nested and flat
aliases remain present as compatibility fields.

`setPosture` with a named `posture` checks Android posture support before sending any fold, unfold,
posture, or device-state override/reset command. It uses hydrated supported
postures, falling back to `cmd device_state print-states` when that inventory is
absent or unreadable. Unsupported requests fail with an actionable error listing
the supported postures/states and confirming that nothing was changed. Empty
state lists and DEFAULT-only states do not establish fold support. If the
device-state service is unavailable, hydrated fold support and an observed
matching posture are required.

After named-posture dispatch, Android must reach the requested committed state or, for postures
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

On Android, folding a device such as a Pixel Fold can raise the "swipe up to
continue" keyguard even though no lock credential is set. When the device was
unlocked before the posture change and the keyguard now showing is definitely not
secure, `setPosture` dismisses it and returns `keyguardDismissed: true`. A secure
or unreadable lock state is left alone (call `wakeAndUnlock`), and if dismissing
fails the result carries a `warnings` entry saying so.

Both `rotate` and `setPosture` declare output schemas and return the same JSON
payload in text content and `structuredContent`. Ordinary clients receive
`structuredContent` unless `--tool-results-no-structured-content` is enabled.

`setPosture` accepts exactly one of `posture` or `hingeAngle`. `hingeAngle` is a
finite number of degrees from **0 through 180 inclusive** and is **BEST EFFORT**,
for Android emulators and multi-panel iPhone Duo simulators only. `displayPreset`
requires a named posture and cannot be combined with an angle.

Android tries `adb emu sensor set hinge-angle0 <deg>` once without retries or a
fold/unfold/posture fallback. Support is detected from the command's own output at
call time using the existing console failure check. A rejected console command
returns
`{ "status": "unsupported", "message": "..." }`, including the raw first
non-empty output line as the reason; no state changed. Physical Android angles
are likewise unsupported because they require the emulator console. An unreachable
ADB or timeout while setting, or an abort at any stage, throws an actionable
operational error. After acceptance, `adb emu sensor get hinge-angle0` reads the
angle back, strictly parsing one non-empty line of `hinge-angle0 = <n>`. A mismatch
of more than 1 degree warns with the requested and actual angles; an unreadable
or failed read-back warns that the angle could not be verified. These warnings
remain best effort and do not fail the request.

After an accepted Android angle, committed `cmd device_state state` is mapped
through `cmd device_state print-states`, polling for up to 3000 ms. A known mapped
posture is cross-checked against the fresh final observation: two known postures
that disagree fail with an actionable error naming both and the console's OK
reply. Unavailable service, unreadable/unmapped committed state, or stale final
observation produces `posture: "unknown"` and a human-readable `postureReason`.
A known committed posture can be reported when the final observation's posture
is unknown. No angle-to-posture thresholds are inferred.

Arbitrary iOS angles require a connected runner advertising `set_hinge_angle`,
shipped in release 0.0.82. The stale-runner gate requires this command only on
simulators. A runner without that advertisement (including a missing handshake)
returns unsupported and must be updated to a runner that advertises it; no hinge
request is sent and no state changed. Physical iOS and non-foldable simulators
retain their existing unsupported results. Named iOS postures retain the existing
0/130/180 mapping and are not gated by this new capability check. An angle's resulting posture
comes from the observed active panel: cover reports closed, inner reports its
observed posture (or opened if the inner panel is known but posture is unknown),
and an indeterminate panel reports unknown with a reason. The runner's reported
angle is compared with the request: a difference of more than 1 degree warns
with both angles, and a missing angle warns that it is not verifiable. Neither
warning fails the request.

Named-posture results retain `message`, the requested `posture`, and `display`
(key, role, posture, generation), with optional `locked` and `warnings`. Angle
results also echo the requested `hingeAngle`; `posture` is the device read-back
or `"unknown"` with `postureReason`. Android also reports `observedHingeAngle`
when the console read-back is valid; iOS reports it when the runner returns an
angle. Mismatched or unverified angle messages describe the angle as requested.
Both request kinds share the same device lock, supersession checks, cache invalidation, and
final observation/generation fence. Unsupported angles return `status:
"unsupported"` with a reason and no state change; operational failures throw
actionable errors.

`rotate` returns `success`, `orientation`, `value`, and `message`. Optional fields
include `currentOrientation`, `previousOrientation`, `rotationPerformed`,
`orientationLockHandled`, `orientationLockState`, `warning`, `warnings`, `error`,
`staleDisplay`, `effect`, and a finalized `observation`/`observationDiff`.
Successful no-ops report `rotationPerformed: false`. Returned failures retain
the structured result with `success: false` and set the MCP `isError` flag.

### Localization, display, and event options

`changeLocalization.appId` selects the Android app package for locale changes.
On Android, `displayConfig.reset` restores font scale and density to the device
baseline (`settings delete system font_scale`, `wm density reset`). Font reset
accepts an absent override or the effective AOSP default scale of 1.0. Night mode
is restored only to the value `displayConfig` itself replaced on that device
before its first theme write in this process; later theme writes preserve that
original value. Without a recorded value, night mode is left unchanged. Android
reset never forces light mode. The in-memory record survives feature instances,
is cleared after a confirmed restore, and is lost when the process restarts.
Failed restores keep the record for retry. The iOS Simulator reset continues to
restore light appearance. Failed `displayConfig` results set MCP `isError: true`.
`shake.duration` is an integer from 1 to 1,798,000 ms (default 1000); the maximum leaves 2 seconds for action-timeout overhead under the 30-minute MCP request limit. Invalid values are rejected before shaking. `shake.intensity` is an Android acceleration value from 1 to 1,000 (default 100); iOS ignores it. The maximum is a conservative bound because the repository does not define an emulator sensor limit. Android shake restores the acceleration vector read before the shake; when read-back fails, it uses the issue-reported emulator resting vector `0:9.77622:0` and includes `restoreWarning` in the result.
`biometricAuth.errorCode` supplies the BiometricPrompt error code for `action: "error"`.
On iOS, `match`, `fail`, `cancel` and `error` first arm an `AutoMobileBiometrics`
override through the app's AutoMobile iOS SDK (DEBUG build, app in the foreground),
which the app reads with `consumeOverride()`; `ttlMs` and `errorCode` apply as on
Android. On the Simulator, `match` and `fail` also post the BiometricKit event so a
pending system prompt completes. Without the SDK, the Simulator falls back to
BiometricKit events (`match` and `fail` only) and a physical device is unsupported.
On iOS, `cancel` and `error` only arm the SDK override; the app must read it via
`consumeOverride()`, as no system prompt is completed for them.
`enroll` and `unenroll` always use the Simulator.

`postNotification` takes `title`, `body`, and `appId` (target Android package or iOS
bundle ID; required on iOS, while Android defaults to the foreground app if omitted). `actions` supplies
Android buttons, each with `label` and `actionId`.
`sendSms.message` is the SMS body (at most 1024 characters, without newlines or NUL).
`wakeAndUnlock.pin` supplies a secure Android unlock credential; it may be omitted
if one is already remembered for the session and is ignored on iOS.

`changeLocalization.timeZone` accepts a zone ID such as `America/Los_Angeles`. A malformed
ID, a wrong-case spelling of a known zone (the device looks IDs up case-sensitively), or a
bare UTC offset such as `+05:00` is refused before anything is written. Android also accepts
Java custom IDs such as `GMT+5` or `GMT-08:00`. An ID shaped like `Area/Location` that the
host does not know is still sent, with a note that the host could not validate it, and the
device read-back decides whether it took effect. A successful change reports
`timeZoneWarning`: the stored value read back, which does not confirm that running apps
observe the new zone.
`timeFormat` selects `"12"` or `"24"`, and `textDirection` selects `ltr` or `rtl`.
`calendarSystem` accepts calendar identifiers such as `gregory`, `japanese`,
`buddhist`, or `islamic-civil`. `restartApp` is the iOS bundle ID to relaunch
after a locale change.

`displayConfig.fontScale` changes Android system text scale; `"default"` removes
the explicit override and restores the inherited default. Omission leaves it
unchanged. `shake.intensity` sets Android shake intensity (default 100).

`phoneCall.phoneNumber` is required except for the hold action.
`sendSms.phoneNumber` specifies the sender's number.
On iOS both tools need the app under test to embed the AutoMobile iOS SDK in a
DEBUG build and be in the foreground: `phoneCall` reports the call through
CallKit, and `sendSms` posts an SMS-style local notification. Without the SDK
they return an error that says so.
`postNotification.channelId` supplies the Android channel ID or iOS APNs category.
`imageType` selects `normal` (default) or `bigPicture`; `imagePath` is the host
image path for `bigPicture`. The host reads only the file's first bytes and
rejects files over 16 MiB. It accepts PNG, JPEG, WebP, GIF and BMP everywhere,
and HEIF/HEIC (decoded on Android 8.0+) and AVIF (Android 14+) with a warning,
because the app falls back to showing the notification without the image on a
device that cannot decode them.

#### postNotification SDK compatibility

The app's SDK receiver reports `0` (failed), `1` (posted) or `2` (posted, but the
requested big picture could not be loaded, so it was shown without it). The host
maps `2` to `success: true` with a warning and fails closed on any code it does
not know, naming the code. A host older than the app's SDK predates code `2`, so
an image-less `bigPicture` post that was actually posted is reported as
`success: false` and a retry would post a duplicate. Update the host (AutoMobile)
before, or together with, the SDK in the app.

`biometricAuth.modality` selects `any` (default), `fingerprint`, or `face`.
`fingerprintId` defaults to 1 for match/error and 2 for fail/cancel.
`ttlMs` sets the SDK override lifetime in milliseconds (default 5000).

### Acquisition, deletion, and snapshot options

`deleteDevice.mode` is `"destroy"`: stop and permanently delete the platform device
representation. `timeoutMs` is the total positive integer teardown timeout in
milliseconds, at most 890000.
`getIosSimulatorCapabilities.deviceType` selects a CoreSimulator device-type
identifier from `automobile:devices/images`.

`getAndroid` and `getApple` accept `bootTimeoutMs` for finding, recovering, or
booting the OS and `automationReadyTimeoutMs` for installing, updating, starting,
and verifying the automation runner. Each defaults to 180000 ms; their sum,
including defaults for omitted fields, must not exceed 890000 ms.

`setDeviceResources` and `provisionDevice.resources` results include `requested`
and an independent `observed` full-platform resource snapshot after configuration,
including unrequested groups. No read path yields `unsupported` with a reason;
failed reads yield `unknown`. Explicit opposite enabled/disabled states set
`success: false` and name the resources in `observationContradictions`, using the
existing MCP error response (provisioning retains the device/session). Unknown or
unsupported observations do not add failures. Existing mutation fields retain
their shape and meaning. Observation uses at most half the remaining resource deadline and shares the abort
signal; exhausted reads report `unknown`, and provisioning replay refreshes it.
Identical package and launchctl reads are reused only within one observation.
Cancellation after mutation carries the completed result on the propagated error
as `deviceResourceResult` (including any restore receipt). Non-abort observation errors are
logged and omit `observed` while retaining the mutation result.

`reconcileDeviceResources` targets a booted iOS Simulator and returns its incarnation
`identity` (UDID, runtime, device type), the `profileFingerprint` of the requested map,
`drift` found before any repair, `remainingDrift`, the final independent `observed`
snapshot, and, after a repair, the `applied` delta result. `success` is true only when
every requested resource is observed in its requested state and no owned extra remains.
`releaseOwnedExtras: true` (with `repair`) re-enables services AutoMobile disabled
earlier that the profile omits; services AutoMobile never changed are never touched.

`provisionDevice.operationId` is a caller-generated idempotency key.
`deleteDevice.operationId` is a caller-generated idempotency and diagnostic
correlation ID. `verifyAbsence` requires a complete inventory observation proving
durable absence. `cancellationPolicy: "cancel-on-request-abort"` cancels accepted teardown when
the MCP request is aborted; use it for deadline-critical, caller-owned cleanup
that must stop when its caller stops waiting.

`startDevice.screenSize` requires positive, finite width and height in pixels.
Matching allows a 10% difference in each dimension.

`deviceSnapshot.vmSnapshotTimeoutMs` accepts a positive integer up to 1800000 ms
(30 minutes) for capture and restore. When omitted, the configured timeout applies
(default 30000 ms).

`deviceSnapshot.useVmSnapshot` uses an emulator VM snapshot;
`vmSnapshotTimeoutMs` sets the VM snapshot timeout in milliseconds.
`strictBackupMode` is iOS-only and fails the whole snapshot unless every
requested bundle is backed up (all-or-nothing).

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
`unhealthy: { reason, since }`. Reasons are `biometric-enrollment`, `network-condition`, `clock`, or
`app-cleanup` (an `executePlan` app cleanup did not complete); `since` is the daemon's timestamp in milliseconds. Unresolved restore failures
exclude devices from available/idle counts and new session allocation. Biometric,
network, and app-cleanup failures get three background recovery opportunities with 1s/2s/4s backoff;
a live owner is never restored by this recovery. Clock failures retain the existing
busy quarantine and retry until success or removal. No automatic erase/reboot occurs;
use `killDevice`/`startDevice` for replacement if recovery is exhausted (an `app-cleanup` marker that
exhausts its three attempts is held until then, and the allocation error spells out the `killDevice` call). Health markers
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

Read-only Android inventory shares successful name/display enrichment and AVD listings for
2.5 seconds, keyed by the device-list observation to avoid reusing a replaced emulator's
identity. The booted resource has an 8-second compute budget; the images resource has a
9-second response budget; `listDevices` configured-image fallback has a 2-second budget.
Known devices/images remain available on expiry with additive `retryable: true` and
`retryAfterMs: 1000` hints: booted `enrichment` names `pending` work, tool `enrichment.missing`
names `configuredImages`, and image observation errors name `catalog` and, when unfinished,
`configuredInventory`. Retry hints suggest a delay, not a completion deadline. One background
catalog fetch continues for up to 30 seconds and retains its completed stage for 2.5 seconds,
so a short retry normally gets the full inventory. The device-free five-emulator mixed-load
fixture bounds the three sequential reads at 25 seconds and each response below its
15-second client deadline. See [device resources](design-docs/device-resources.md) for the
constants, cancellation behavior, and completeness shapes.
Persistent Android provenance failure returns `enrichment: { complete: false,
missing: ["provenance"], retryable: false, reason }`; the reason names the cmdline-tools
failure once and clients should address it instead of polling. Pending provenance is
retryable; success omits the enrichment field. Catalog lifecycle invalidation returns
`code: "superseded"` with retry hints, hard-cap expiry returns `code: "timeout"`, and a
genuine failure retains `code: "failed"` with its cause. ADB inventory wait expiry reports
incomplete discovery with `code: "timeout"`, `retryable: true` and `retryAfterMs: 1000`
while the shared 10,000 ms read continues; coalesced AVD reads use a 30,000 ms shared cap.

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

### Network options

`getNetworkGraph.method` filters by HTTP method.
`mockNetwork` uses regex `host` and `path` patterns and an HTTP `method` (default
`"*"`). A positive integer `limit` caps mock responses. Configure `statusCode`
(default 200, range 100–599), `responseHeaders` (string values), `responseBody`
(the mock body), and `contentType` (default `application/json`).

`network.simulateErrors` configures error simulation with `errorType` (`http500`
by default, or `timeout`, `connectionRefused`, `dnsFailure`, `tlsFailure`),
optional positive `limit`, and positive `durationSeconds`. Set `cancel: true`
to cancel active simulation; otherwise `durationSeconds` is required.
`notifFilter` selects `all`, `errors`, or `slow` notifications.
`notifDebounceMs` sets the notification batching delay in milliseconds (zero is
allowed); `slowThresholdMs` is the positive duration threshold in milliseconds
at or above which a request counts as slow.

`clearMockNetwork.mockId` selects one mock to clear; omit it to clear all.
Mock rules and error simulation are kept per device. When a session is released
or leaves a device, only the rules and simulation that session installed are
removed, and the rest of the device's set is pushed to it. Rules and a
simulation installed without a session (direct mode), or by another session, are
never removed by a session release, even on the same device; sessionless state
has no automatic lifetime and stays until `clearMockNetwork`, a cancelled or
expired simulation, or removal of the device. A replaced simulation belongs to
the session that installed the replacement.
`getNetworkGraph.sinceSeconds` sets the lookback in seconds, and `minRequests`
sets the minimum request count.

### Plan and recording options

`barrier.lock` names the shared barrier that devices synchronize on.
`criticalSection.lock` names its shared barrier lock.

`executePlan.planContent` contains YAML plan content (also accepts a `base64:`
prefix). `startStep` is the start step index (default 0).
Nested `executePlan` calls run on the enclosing plan's session/device. Remove
`devices`/`device` labels from the nested call and device declarations from its
YAML; otherwise execution fails before label allocation with: "Nested executePlan
cannot use devices/device labels. Remove the labels; nested plans run on the
enclosing plan's session/device."
`deviceAllocationTimeoutMs` is the device allocation timeout in milliseconds
(default 300000). For multi-device failures, `abortStrategy` selects `immediate`
(default) or `finish-current-step`. `testMetadata` supplies test identity
(`testClass`, `testMethod`) and optional build metadata for execution records.
`cleanupAppId` selects the app for cleanup and `cleanupClearAppData` requests
clearing its data. `captureObserveSteps` attaches `summary` or `full` observe
snapshots to the step debug trace; multi-device plans ignore this capture option.
`holdSessionOnFailure` keeps the session and its device after a failed run instead
of auto-releasing them, so the caller can recover and resume on the same device;
the caller then releases the session (plans with device labels are always released).

`barrier.deviceCount` specifies how many devices must arrive before the barrier
lifts. `criticalSection.deviceCount` specifies the devices required at its
barrier before serial execution.

`recordSteps.planName` names the plan for `action: "end"`. The end response
carries a `warnings` list when a call was skipped (a file-staging call with a
host `sourcePath`, or a param over 64 KiB) or recorded in a weakened form:
`resetKeychain` is recorded with `confirm: false`, so a replay stops at that
step until you set `confirm: true` in the plan by hand. A recording whose calls
were all skipped fails with an error that lists them.
`exportPlan.recordingId` identifies the recording to export, and `planName`
names the exported plan.

### Video recording quality and limits

`videoRecording.resolution` sets positive integer `width` and `height`;
`format` accepts `"mp4"`. `highlights` is an array of circle `shape` entries with
`bounds`, optional `description`, and optional `timing.startTimeMs` (nonnegative
integer milliseconds).

`videoRecording.recordingId` identifies a recording to stop.
Start options include `qualityPreset` (`low`, `medium`, or `high`),
`targetBitrateKbps` (positive integer bitrate in Kbps), `maxThroughputMbps`
(positive throughput limit in Mbps), and `fps` (positive integer frames per
second). The throughput limit caps the target bitrate at
`maxThroughputMbps * 1000` Kbps. Built-in defaults are `low`, 1000 Kbps,
5 Mbps, and 15 fps; configured recording defaults can override them.
`qualityPreset` is a configuration label; it does not automatically replace the
explicit bitrate or frame-rate settings.

`maxDuration` sets a positive integer duration in seconds (default 30), capped
at 300 seconds on Android and 3600 seconds on iOS. `outputName` supplies a
recording label.

The stop result reports two durations. `durationMs` is the wall-clock time
between start and stop. `videoDurationMs` is the playable duration read from the
finished file's MP4 header (`mvhd`); it is omitted when the header cannot be
read. The two can differ: Android `screenrecord` writes frames only when the
screen changes, so an idle screen can yield a file shorter than the wall-clock
span (for example 18.2 s of video for a 25.5 s recording). Use
`videoDurationMs` for assertions about the file and `durationMs` for how long
the recording ran.

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

| Tool                               | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ♿ <code>accessibility</code>      | Reads or controls Android TalkBack and iOS VoiceOver, returning fresh device state regardless of feature flags; when `force-accessibility-mode` or `accessibility-auto-detect: off` changes what the action tools assume, `detectionOverride` names it. After enabling TalkBack, reports a detected blocking system runtime permission prompt via `warning` and `blockingPrompt`; AutoMobile does not dismiss it. Use `observe`, then `tapOn` to answer it. |
| 🎯 <code>accessibilityFocus</code> | Sets or clears Android TalkBack focus by resource ID, text, or content description.                                                                                                                                                                                                                                                                                                                                                                         |
| 🔀 <code>setToolEnabled</code>     | Controls which AutoMobile tools appear in `tools/list` for the current MCP session; an omitted tool remains callable directly by name through `tools/call` — one exact name via `toolName`, or a batch via `toolNames`; unknown or hidden names reject the batch, while always-on names are returned in `skipped`.                                                                                                                                          |

### Accessibility focus selectors

`accessibilityFocus.resourceId` targets a resource ID. `contentDesc` matches the
exact content description or accessible label, distinct from visible `text`.

Setting focus on a node that already holds accessibility focus, or clearing focus
on one that does not, succeeds without sending an action and reports
`alreadySatisfied: true`.

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

A `changed` entry's `selector.index` uses the same duplicate candidate set and
ranking as the next observation's skeleton. A duplicate selector without a safe
index carries `selector.ambiguous: true`, including inert matches and groups
with a child that can promote to a tap or toggle ancestor. Unique selectors
carry neither `index` nor `ambiguous`; selectors with an index omit `ambiguous`.

`observe({ project: "full", scope: { focus: ... } })` also accepts the action
selector vocabulary: exactly one `elementId` or `text`, optional `container`
(recursive), `index`, and `selectionStrategy`. The shared resolver resolves
outermost-first through strict descendants, including anonymous wrappers;
noninteractive containers are valid. `unique` is recommended for intentional
queries and applies at every unindexed level. Explicit indices override
uniqueness within the resolver's existing ranked candidate set at that level.
Scope cannot expose descendants missing from the automation hierarchy.

For example, on Android (resource IDs) or iOS (accessibility identifiers):

```json
{
  "project": "full",
  "scope": {
    "focus": {
      "elementId": "item_42",
      "container": { "elementId": "cart_A" },
      "selectionStrategy": "unique"
    }
  }
}
```

The returned `observeScope.focus.chain` lists outermost-to-target selectors and
`matchCount` at each level, before index selection. Selectors use `elementId` /
`text` and retain their enclosing `container`, indices, and effective strategy,
so the final selector can become an action's `container` (for example, tap
`remove` within that item). Use qualified Android resource IDs when needed.
No scope metadata is added to an observation that did not request a scope.
Legacy `{resourceId}` / flat `{text}` anchors retain their exact-ID / substring
matching, first-node behavior, and unchanged metadata without `chain`. An object
with `elementId` or `container` is a nested selector; every other object keeps
the flat `resourceId`/`text` anchor, ignoring extra fields. Boolean foreground-app
focus keeps its existing metadata.
On the default skeleton projection, `focus` and `region` run on the full tree and
the skeleton and context keep only the rows that survive them; `overview` has no
skeleton form and is reported in `observeScope.gatedOff`.

A failed new selector returns an empty subtree and `observeScope.focus.matched:
false`, with the resolver's unchanged `error`. A missing leaf reports
`Target not found within container`; missing or ambiguous ancestors additionally
carry `containerFailure: { level, reason: "not-found" | "ambiguous", selector }`.
Levels are one-based from the outermost container. Successful ancestor levels
remain in `chain`; target counts are included when its ancestors resolved.
`observe.waitFor` container timeouts expose the same optional `containerFailure`
at the top level, alongside the existing `timeoutReason` and candidates.

`observe.waitFor` element conditions (`appear`, `disappear`, `clickable`,
`textEquals`, `countStable`, and legacy element predicates) accept a nested
`container` chain and leaf `selectionStrategy: "first" | "random" | "unique"`.
The `timeout` / `timeoutMs` wait budget is capped at 1,770,000 ms so the wait
and its 30-second dispatch/report allowance fit within the caller's 30-minute
request limit.
Each container names exactly one `elementId` or `text` and may carry its own
zero-based `index`, `selectionStrategy`, and enclosing `container`. The outermost
container resolves first; later levels and the leaf search only strict descendants
in the automation hierarchy, including through anonymous wrappers. Rectangles do
not establish scope. The complete chain is resolved again on every fresh poll.

`unique` requires one eligible match at every unindexed scope level and at the
leaf. An explicit container `index` overrides uniqueness at that level; an
out-of-range index keeps polling. Missing or ambiguous scopes and ambiguous unique
leaves keep polling within the timeout. Scoped timeouts include a failing-level
`timeoutReason` and at most five diagnostic `candidates`. Default and explicit
`first` choose the first eligible match; `random` chooses an eligible match.
Compound legacy element fields are combined before the leaf strategy is applied.

Scoped absence (`for: "disappear"` or `absent`) is satisfied only after the scope
resolves and the leaf is absent inside it. A missing or ambiguous scope is not
proof of absence, even if the same leaf exists elsewhere. `absent` uses the
wait's `container` and can override the leaf strategy inside its predicate.
Scoped behavior is opt-in through a nested container, any container index or
strategy, or an explicit leaf strategy. For compatibility, a plain flat one-level
`{elementId}` or `{text}` container without an index or strategy retains the legacy
behavior: a missing container satisfies `disappear`/`absent`. Unscoped calls also
retain their behavior. To wait for a container itself to disappear, target that
container at its enclosing scope. `for: "stable"` rejects both container and leaf
strategy; textAny-only and posture-only waits reject leaf strategies.

Inspect the hierarchy with `observe` first:

```json
{ "project": "full" }
```

Then use the captured identifiers for a scoped wait. After confirming the
`cart_A > item_42 > remove` ancestry, call `observe` again to wait for that
removal control to disappear:

```json
{
  "waitFor": {
    "for": "disappear",
    "elementId": "remove",
    "selectionStrategy": "unique",
    "container": {
      "elementId": "item_42",
      "container": { "elementId": "cart_A" }
    },
    "timeoutMs": 5000
  }
}
```

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

### Android SharedPreferences user targeting

For `scope: "sharedPreferences"`, `getPreference` and `setPreference` accept an optional
`userId` (for example a work profile). It is passed to `adb shell run-as <pkg> --user <id>`
for nonzero users; user 0 keeps the unscoped `run-as <pkg>` command. When omitted, user 0 is
used whenever the package is installed for it. Another user is used only when the package is
not installed for user 0 and is installed for exactly one other running user; if several such
users have it, the call fails and asks for `userId`. If the device's users cannot be listed,
user 0 is used (with a warning). The result always reports the `userId` that was read or
written. `userId` is rejected for other scopes.

`setKeyValue`, `removeKeyValue` and `clearKeyValueFile` accept the same optional `userId` on
Android. It applies to their direct-file fallback (the `run-as` XML edit used when the SDK route
is disabled by inspection or mutation policy) and resolve the default identically: an explicit
`userId` wins, otherwise user 0 when the package is installed for it, else the one other running
user that has it (several such users: the call fails and asks for `userId`). The SDK route itself is not user-scoped.
The mutation queue is keyed per user, so the same file in two users never serializes together.
`userId` is rejected on iOS devices. The `automobile:devices/{deviceId}/storage/...` entries
resource has no input, so its `run-as` fallback reads the same default user.

### iOS UserDefaults preferences

For a simulator check with an app that does not embed the SDK, run
`bash scripts/ios/userdefaults-no-sdk-smoke.sh <booted-simulator-udid>`.
It installs and removes a disposable probe app, exercises the real container route
for standard and custom suites, and checks the app's own `UserDefaults` after cold
relaunch. It covers an absent runner and the old/new SDK-refusal messages injected
at the transport seam; it does not build or exercise a live CtrlProxy runner.
Run it on a dedicated simulator. Xcode and the repository's Bun dependencies are
required.

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

Writes fall back when the client is absent or closed, or the runner refuses the
SDK route before dispatch because the target app lacks the SDK. The runner marks
these refusals with `sdk_unavailable_not_dispatched`; exact legacy capability
refusals are also recognized. Reads fall back on these refusals too. Dispatched
or ambiguous SDK write failures never cause a container write and report that the
write may or may not have been applied. Inspection-disabled
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

`terminateApp` reports `success` and `packageName`, with optional `wasForeground`
(omitted when the pre-terminate foreground app could not be determined),
`wasInstalled`, `wasRunning`, `userId`, and action observation metadata. Already
absent or stopped apps are successful no-ops. Failed terminations throw actionable
errors.

`getDeviceState` and `setDeviceState` report `success`, `deviceId`, and `platform`,
with optional `error` and requested field results: `doNotDisturb`, `connectivity`,
`biometrics`, `networkCondition`, `clock`, and (writes only) `location`. Reads may
also include `displays` and `unsupported` field names. Field results report
`supported` and optional verification, capability, method, values, warning, or
error metadata. Clock writes can report `outcome` as `changed`, `unchanged`, or
`restored`; degraded network writes report capability `partial`. On an iOS
Simulator, `networkCondition` is per-app only: `offline` or `none` with `appId`,
within a session, through the opt-in network filter. It reports `scope: "app"`,
the acknowledged `rule` (revision, owner generation, lease), `coverage: "partial"`
and `limitations`; reads list the provider's active `rules` for that simulator.
Setter TTL
rejection and biometric capture failures also return structured failure payloads
without MCP `isError`.

### Compact action metadata

Action responses compact unchanged metadata by default within a session and device:
`observation.insets`, `systemInsets`, `backStack`, `gfxMetrics`,
`displayedTimeMetrics`, `deviceLock`, `accessibilityState`, and `freshness`, plus
raw `viewHierarchy.insets` and `viewHierarchy.systemInsets`. First delivery,
a new session, and every device switch send available blocks in full; changed
blocks reappear. Stale freshness, unstable gfx metrics, and partial back stacks
remain inline. `backStack.capturedAt` alone does not count as a change.
A duplicate top-level `element` is omitted when identical to
`selectedElement.matchedElement` and not required by the output schema.
Use `AUTOMOBILE_ACTIONS_COMPACT_METADATA=0`, `--no-actions-compact-metadata`,
or feature flag `actions-compact-metadata=false` to restore full metadata.
`--actions-compact-metadata` or exact env `1` explicitly enables it. Negative CLI
wins over positive CLI, then exact env `0`/`1`, then persisted state, then on.
An explicit CLI/env choice applies to that connection only: proxies relay it on
the connection profile, never restart the shared daemon for it, and never persist it.
Unset or other env values express no preference and use the daemon's effective setting.
`observe` responses remain full. See [interaction loop](design-docs/mcp/interaction-loop.md).
