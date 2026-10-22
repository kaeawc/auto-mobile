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

`accessibility`, `accessibilityAction`, `accessibilityAudit`, `accessibilityFocus`, `appLifecycle`, `audit`, `barrier`, `biometricAuth`,
`changeLocalization`, `clearKeyValueFile`, `clearMockNetwork`, `clipboard`, `crashApp`,
`changeLocalization`, `clearKeyValueFile`, `clearMockNetwork`, `clipboard`,
`compareScreenshot`, `crashApp`,
`criticalSection`, `deleteDevice`, `deviceSnapshot`, `displayConfig`, `dragAndDrop`, `dragPath`,
`executePlan`, `explore`, `exportPlan`, `getAppPermissions`, `getDataStore`, `getDeepLinks`, `getLogs`,
`getDeviceState`, `getIosSimulatorCapabilities`, `getNavigationGraph`, `getNetworkGraph`,
`getNotificationPolicy`, `getPreference`, `highlight`, `hitTest`, `homeScreen`,
`identifyInteractions`, `inspectPackageSigning`, `installApp`, `keyboard`, `launchApp`, `listApps`, `listDataStores`,
`measureStartup`, `mediaSession`, `mockNetwork`, `multiTouch`, `navigateTo`, `network`, `observe`, `openLink`,
`performanceTrace`, `phoneCall`, `pinchOn`,
`postNotification`, `pressButton`, `prototype`, `putAppFile`, `recentApps`,
`reconcileDeviceResources`, `recordDeviceGestures`, `recordToolCalls`, `removeKeyValue`,
`resetAppLogs`, `resetKeychain`, `rotate`, `selectAllText`, `sendKeys`, `sendSms`,
`setActiveDevice`, `setAppLinks`, `setAppPermissions`, `setDeviceResources`, `setDeviceState`,
`setKeyValue`,
`setNotificationPolicy`, `setPosture`, `setPreference`, `setSensor`, `setUIState`, `shake`, `snapshotOf`,
`sqlQuery`, `statusBar`,
`resetAppLogs`, `resetKeychain`, `rotate`, `selectAllText`, `sendBroadcast`, `sendKeys`, `sendSms`,
`swipeAt`, `swipeOn`, `systemTray`, `tapAny`, `tapAt`, `tapOn`, `terminateApp`, `uninstallApp`,
`videoRecording`, `wakeAndUnlock`, `windowMode`.

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

`biometricAuth`, `dragAndDrop`, `dragPath`, `homeScreen`, `launchApp`, `multiTouch`, `observe`, `openLink`,
`pinchOn`, `pressButton`, `recentApps`, `rotate`, `selectAllText`, `sendKeys`,
`shake`, `swipeAt`, `swipeOn`, `systemTray`, `tapAny`, `tapAt`, `tapOn`, `terminateApp`.

These tools also accept `includeExtras: true` to opt in to raw accessibility
`extras` metadata in `structuredContent` only (default off). This is meaningful
with `project: "full"` or `raw: true`; text content always strips `extras`.

Skeleton output contains actionable entries; the collapsed keyboard marker `<ime>` is not a
selector. Use `sendKeys` or `keyboard` for keyboard input.

## Observe & navigate

By default, `observe` returns the same JSON payload in `structuredContent` and
`content[0].text`, with every `extras` property stripped. To inspect raw
accessibility metadata, pass `includeExtras: true` with `project: "full"` or
`raw: true`: only `structuredContent` retains `extras`; text remains compact.
Error results (`isError: true`) carry their JSON error detail in `content[0].text`.

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
`structuredContent` is added for this tool. For tools that return both, the
structured payload equals the parsed text payload by default. `extras` require
`includeExtras: true` and appear only in structured content; text always strips
them. Error results carry their JSON error detail in `content[0].text`.

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

`tapOn`, `tapAt`, `swipeAt`, `swipeOn`, `pinchOn`, `dragAndDrop`, and `sendKeys` accept the
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

`swipeOn.durationMs` sets the forward-stroke duration exactly instead of a `speed`
preset. It is an integer from 1 to 3000 ms (the gesture transport allows a 5000 ms
request, minus 2000 ms of dispatch headroom). `durationMs` cannot be combined with
`speed` or `lookFor`; out-of-range values and a `speed` + `durationMs` pair are rejected
by the schema and the action before any dispatch. Velocity follows from swipe
distance divided by duration; the result's `duration` (and `x1`/`y1`/`x2`/`y2`) report
what was dispatched so the fling can be reproduced, and a single successful swipe also
reports `velocityPxPerSecond` (native px/s, points/s on iOS), computed with the same helper as
`swipeAt` from `effectiveDurationMs` when the iOS runner clamped the stroke, else `duration`.
It is omitted when the route ignored the duration (`durationIgnored`, the TalkBack semantic
scroll), for `boomerang` (`duration` is both legs) and for `lookFor` searches. With `boomerang`, `durationMs`
applies to the forward stroke only (the return leg keeps `returnSpeed`), and the
existing 5000 ms boomerang budget still applies. `swipeAt.durationMs` shares these
bounds; `lookFor` and `boomerang` do not apply to `swipeAt`. Real limits: the value sent is the
requested duration, not a measured one. Android accessibility gesture strokes complete
at the last emitted event rather than the planned duration, and the injection path may
quantize very short strokes, so treat durations below roughly 50 ms as a "very fast
fling" request rather than exact timing; the effective minimum on each platform is not
yet measured. Verify the resulting velocity on
a device when a test depends on a pager or dismiss threshold.

### Multi-finger gestures

`multiTouch` performs a simultaneous 2 to 5 finger `tap`, `longPress`, or `swipe`.
It is a dedicated tool (default-off, like `pinchOn`) rather than a `fingers` option on
`tapAt`/`swipeOn`: it keeps the multi-pointer wire request, finger layout and capability
gate in one place, and leaves the single-finger tools unchanged. `tapOn`/`tapAny`
element targeting, `swipeAt` coordinate-to-coordinate travel, and multi-finger
`doubleTap` are not covered.

- **Layout.** `x`/`y` (with `coordinateSpace`) is the center of a horizontal row of
  fingers, `fingerSpacing` px apart (default 10% of the width, kept within 40 to 160;
  allowed 10 to 400). The row is shifted to stay on screen; a row wider than the
  screen is refused. Fingers share one stroke, so a left or right swipe leaves the
  fingers trailing each other along the travel axis; swipe up or down for fingers
  side by side. The result's `points` lists every down point and `x1`/`y1`/`x2`/`y2`
  the first finger's stroke.
- **Swipe.** `direction` is required, and `distance` (default 30% of the travel axis) is
  clamped to the room left so every finger stays on screen; a swipe with under 20 px of
  room is refused, and a clamp is reported in `warning`.
- **Duration.** `tap` holds 50 ms. `longPress` takes `durationMs` 500 to 3000 (default 1000) and `swipe` 1 to 3000 (default 300); the cap is the 5000 ms gesture request
  minus 2000 ms of dispatch headroom.
- **Layers.** With `layer`, every finger's down point is checked before dispatch.
- **Android.** Two fingers use the existing CtrlProxy request. Three to five fingers
  need the `multi_finger_gesture_v1` capability: an older APK would silently perform
  two fingers, so the request is refused before dispatch with an actionable error.
- **iOS.** The same fingers go through the runner's multi-finger stroke. A request that
  was written but not acknowledged is reported as `outcomeIndeterminate` and is not
  retryable, because it may already have landed.
- **Limits.** A stationary stroke (tap, long press) relies on the platform accepting a
  zero-length multi-finger path; how apps see that on each OS is unverified until it is
  checked on a device.

`swipeOn.fromEdge` (`left`, `right`, `top`, `bottom`) starts a raw swipe at a screen or
panel edge and moves inward, for navigation drawers, the iOS interactive swipe-back,
and edge-pull panels. `direction` must be the inward finger direction (`left` edge ->
`right`, `right` -> `left`, `top` -> `down`, `bottom` -> `up`; `gestureType:
"scrollTowardsDirection"` is resolved first). The touch starts `edgeInset` px (iOS
points) inside the edge, an integer from 0 to 50, default 4, so it stays inside iOS's
roughly 20 pt swipe-back recognizer zone. `at` (0 to 1, default 0.5) is the position
along the edge, and the swipe travels 70% of the screen or panel extent. `fromEdge`
cannot be combined with `container`, `lookFor`, or `autoTarget: true` (an edge swipe
never auto-targets a scrollable). Without `display` the edge is the content edge (system
bars excluded) unless `includeSystemInsets: true` selects the physical screen edge; with
`display`, the selected panel's own edges are used, and omitting `includeSystemInsets`
keeps the full panel rect while `false` uses its content edge. Android gesture
navigation reserves a strip at the physical left and right edges for back, and the
bottom edge for home, so a very-near-edge swipe there may be taken by the system rather
than the app; prefer the default content-edge mode or a larger `edgeInset` when that
happens. Named system gestures ("system back") are not provided. Edge-anchored swipes
are a `swipeOn` option only: `swipeAt` does not take `fromEdge`, `edgeInset`, or `at`.
For a coordinate swipe that starts at an edge, pass a `from` point at the edge with
`coordinateSpace: "normalized"`: `0` is the left or top edge, and `1` resolves to the
last pixel of the right or bottom edge. In absolute coordinates the far edges are
exclusive, so use `width - 1` or `height - 1`; a value equal to the screen size is
rejected as out of bounds.

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
`durationMs` is valid only for long press. On iOS, double tap uses one runner-side double tap. On Android, it uses two native taps
200 ms apart. The result includes `action`. All variants accept `display`.

#### Swipe between two points

`swipeAt({ from, to })` swipes from the point where the finger goes down to the point
where it lifts, so it can draw diagonals that `swipeOn`'s four directions cannot. It is
opt-in: enable it with `setToolEnabled`. Both points use the same native units as
`tapAt`, and `coordinateSpace: "normalized"` (0 to 1) or `"percent"` (0 to 100)
resolve them against the observed `screenSize`. Points outside the screen,
non-finite values, and a `from` and `to` that resolve to the same point (which would
be a tap, so use `tapAt`) are rejected before any input is sent. On Android both
points are rounded to whole pixels first, so two distinct points that round to
the same pixel are also rejected. The result reports the resolved native
`x1`, `y1`, `x2`, `y2` and the `duration` in milliseconds.

```ts
swipeAt({ from: { x: 0.8, y: 0.2 }, to: { x: 0.2, y: 0.8 }, coordinateSpace: "normalized" });
```

For screenshot-derived points pass `image` with one shared source and a `from` and
`to` in that image, as `tapAt.image` does for a single point:

```ts
swipeAt({
  image: {
    unit: "normalized",
    source: { crop: observation.crop, rotation: observation.rotation },
    from: { x: 0.2, y: 0.5 },
    to: { x: 0.8, y: 0.25 },
  },
});
```

`image` is mutually exclusive with `from`, `to`, and `coordinateSpace`; its `from` and `to`
are in `image.unit`, not `coordinateSpace`. Add
`snapshotId` to reject the swipe when the screen geometry changed since that
observation, or the reference expired. `speed` selects `slow`, `normal` (the
default), or `fast` as in `swipeOn`. `durationMs` instead sets the stroke duration
exactly (integer 1 to 3000 ms, the same bounds and transport headroom as
`swipeOn.durationMs`); it cannot be combined with `speed`, and either violation is
rejected before any input is sent. Velocity is the straight-line distance divided by
the duration: the result's `duration` is what was dispatched and
`velocityPxPerSecond` is that velocity in native px/s (points/s on iOS), so a fling can be reproduced.
The same quantization caveat as `swipeOn.durationMs` applies on Android and no
per-platform effective minimum has been measured. `layer` is checked at the `from` point, because touches go to the window under the
finger-down point. `display` (panel key, role, or `active`) swipes on that
Android panel: points, `coordinateSpace` and `image` resolve against the panel's observed
`screenSize`, `snapshotId` and `layer` are checked against its observation, and the display fence
is re-checked before dispatch (a changed or removed display returns `staleDisplay`). The default display uses the same injection as a call without `display`; other panels use CtrlProxy
with the panel's `displayId` (falling back to `input touchscreen -d` if it fails before dispatch, or
on older APKs). A swipe dispatched but not confirmed returns `outcomeIndeterminate`. iOS refuses
`display`.

##### Stylus pointer

`tapAt` and `swipeAt` accept `pointer: { toolType: "stylus" }` to inject a stylus instead of a
finger on Android, through `adb shell input stylus` (no root). `tapAt` supports `tap` and
`longPress` (a zero-distance stylus swipe with the duration); `swipeAt` is the straight two-point
swipe. The shell injects a constant pressure of 1.0, so `pressure` may be omitted or `1`; any other
value is refused, never rounded. Everything else fails with a capability error before any input
and never falls back to a finger touch: iOS, `doubleTap`, `display`, an Android release before
API 31, and a device whose API level cannot be read. API 31 (Android 12) is the first release whose
`input` command sets the injected event's tool type from its source (read from the AOSP tags:
`android-12.0.0_r1` assigns it, while `android-7.0.0_r36` through `android-11.0.0_r48` build the event
without one). That minimum is read from source; a probe app on a device that observes `TOOL_TYPE_STYLUS`
is tracked in #13082. A recorded stylus step keeps its `pointer`, so a replay on a device that cannot
honor it fails instead of becoming a finger touch. TalkBack routing is bypassed (a stylus tap is a raw `input` event), and whether TalkBack's touch exploration
intercepts stylus events is unverified (#13082). Tilt, eraser, hover, pressure curves and `dragPath`
are not supported.

`recordDeviceGestures` exports a swipe that is clearly diagonal (off-axis travel at least
half the on-axis travel), or a swipe with a known path but no direction, as
`swipeAt` with `coordinateSpace: "normalized"` fractions of the recorded screen, so
replay adapts to a different screen size. Straighter swipes stay `swipeOn` with a
direction. Replay on a different orientation maps the same fractions onto the rotated
screen.

`tapAt`, `tapOn`, `tapAny`, `swipeOn`, `swipeAt`, `dragAndDrop`, and `pinchOn` fence
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
role, posture, rotation, screen size, native scale, or app id. A change to the
tap-targeting layout (structure, bounds, class/role, clickable/enabled, visibility,
actions, scrollability, resource id) also rejects a reference, while
text/value/selection changes do not invalidate a reference. Android also
compares a known activity name, window type, and focused window identity and
bounds when both observations provide them. iOS does not provide Android
activity names; its available app-window metadata (when present) describes the
application window and does not detect in-app navigation. A display revision or
runner frame-event counter advancing by itself does not invalidate the reference.
A rejected tap does not silently recapture or retarget.
When a session `observe` cannot produce a reference, it returns
`snapshotReferenceUnavailable`, a `string[]` naming the missing capture
preconditions: `display`, `screenSize`, `rotation`, `nativeScale`, `frameContext`,
`completeHierarchy` (in that order). `completeHierarchy` means the hierarchy capture
was truncated (or a host-capped tree arrived without its uncapped capture).
This field is absent when a reference is returned and on
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

Compose with `testTagsAsResourceId = true` (including AutoMobile's prototypes)
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

### Observation and screenshot resource failures

The observation resources are:

- `automobile:observation/latest`
- `automobile:observation/latest/screenshot`
- `automobile:observation/{deviceId}/{observationId}/screenshot`
- `automobile:observation/session/{sessionUuid}/latest`
- `automobile:observation/session/{sessionUuid}/latest/screenshot`
- `automobile:device-session/{sessionUuid}/screenshot`

An image response has an `image/*` MIME type and a base64 `blob`, with no `text`;
its PNG, JPEG, or WebP bytes and actual MIME type are preserved. A failure has
`mimeType: "application/json"`, a JSON `text` body containing `code`, `retryable`,
and `error`, and no `blob`. Successful JSON observations remain JSON observations,
without a failure `code`.

`retryable` means reading the **same URI** again can succeed. Pending captures
also provide the positive integer `retryAfterMs` (currently 1000 ms). Cached
failures do not start another capture. Observation-scoped URIs identify an
immutable device observation: they never substitute a newer observation's image
or another device's image. A superseded or evicted observation requires a new
`observe` call and its new screenshot URI.

| Code                                          | Retryable                                                      | Remedy                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `INVALID_REQUEST`                             | false                                                          | Correct the malformed percent-encoded URI segment.                                            |
| `OBSERVATION_NOT_RETAINED`                    | false                                                          | Call `observe` again and read the new observation URI.                                        |
| `SCREENSHOT_NOT_READY`                        | true                                                           | Wait `retryAfterMs`, then read the same URI again.                                            |
| `SCREENSHOT_CAPTURE_FAILED`                   | false for cached resources; true for fresh-session screenshots | Call `observe` again for a new cached capture; retry the same fresh-session URI to recapture. |
| `SCREENSHOT_CAPTURE_CANCELLED`                | false                                                          | Start a new capture using `observe`, or request a new fresh-session capture.                  |
| `SCREENSHOT_CAPTURE_SUPERSEDED`               | false                                                          | Call `observe` again and use the new observation URI.                                         |
| `SCREENSHOT_NOT_CAPTURED`                     | false                                                          | Call `observe` with screenshot capture enabled.                                               |
| `SCREENSHOT_FILE_UNAVAILABLE`                 | false                                                          | Call `observe` again to obtain a new retained file.                                           |
| `SCREENSHOT_ACCESS_DENIED`                    | false                                                          | Use the owning session or restore screenshot file access, then obtain a new capture.          |
| `SCREENSHOT_READ_FAILED`                      | false                                                          | Resolve the file/protection failure, then obtain a new capture.                               |
| `OBSERVATION_NOT_AVAILABLE`                   | false                                                          | Call `observe` first, then read its resources.                                                |
| `OBSERVATION_READ_FAILED`                     | false                                                          | Resolve the observation read failure, then call `observe` again.                              |
| `SESSION_NOT_BOUND`                           | false                                                          | Read through the bound/owning device session.                                                 |
| `SESSION_NOT_ACTIVE`                          | false                                                          | Bind an active device session and use its URI.                                                |
| `SESSION_OWNERSHIP_LOST` (fresh-session only) | false                                                          | Bind an active device session and request a new capture.                                      |

When known, cached-resource failures include `deviceId`, `observationId`, and/or
`sessionUuid`; unknown or empty identifiers are omitted. Unauthorized session
reads include only the session identity and never reveal device data. Fields are
additive: consumers should tolerate additional fields and use `code` for
classification rather than parsing `error`. Stored cancellation/supersession
reasons are classified by exact recorder constants; retained-file failures use
errno codes (`ENOENT`/`ENOTDIR` versus `EACCES`/`EPERM`), independently of image MIME.
Fresh-session failure bodies retain their existing `{ code, retryable, error }`
shape and classification.

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

| Tool                                 | What it does                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| 📸 <code>snapshotOf</code>           | Saves a PNG crop of an element or screen rectangle (opt-in).                 |
| 🧪 <code>compareScreenshot</code>    | Records or compares a named screenshot baseline per device profile (opt-in). |
| 👀 <code>observe</code>              | Gets screen hierarchy and screenshot, with optional PNG crop.                |
| 🎯 <code>hitTest</code>              | Estimates hierarchy nodes beneath a coordinate without dispatching input.    |
| 🔍 <code>explore</code>              | Explores an app to build a navigation graph.                                 |
| 🗺️ <code>navigateTo</code>           | Navigates using the learned navigation graph.                                |
| 📊 <code>getNavigationGraph</code>   | Retrieves the navigation graph for debugging.                                |
| 🔗 <code>identifyInteractions</code> | Suggests likely interactions.                                                |
| 🪟 <code>prototype</code>            | Shows, dismisses, awaits events, reports, saves, lists or deletes.           |
| 🖍️ <code>highlight</code>            | Draws a visual highlight around a UI element.                                |

### compareScreenshot

`compareScreenshot` is a visual-regression assertion (#14083). It catches theme, colour,
clipping and missing-icon regressions that leave the view hierarchy unchanged. It
captures the same fresh hierarchy and screenshot as `snapshotOf`, then:

- `baseline` names a host-side baseline under `~/.auto-mobile/visual-baselines/<baseline>/`
  (or the `AUTOMOBILE_DATA_DIR` equivalent).
- `mode` is `record` (write or overwrite the baseline), `compare`, or `recordIfMissing`
  (compare when this device profile has a baseline, record otherwise).
- `target` limits the comparison to one element (`elementId`) or a platform-native
  rectangle (`rect`: Android pixels, iOS points). It defaults to the full screen.
- `mask` lists regions (`elementId` or `rect`) to leave out, such as a clock, an
  avatar or an ad.
- `ignoreSystemBars` (default `true`) also leaves out the visible status and
  navigation bars reported by the hierarchy's insets.
- `threshold.perPixelDelta` (0-1, default 0.1) is the per-pixel colour distance that
  still counts as equal. `threshold.pixelRatio` (0-1, default 0) is the largest share
  of compared pixels that may differ while still matching.

Baselines are stored per device profile: platform, screenshot size, density, font
scale and theme. A `compare` whose baseline exists only for another profile is
refused with `errorCode: "baseline_profile_mismatch"`, naming the differing fields,
instead of being compared. A missing baseline returns `errorCode: "baseline_missing"`,
and a target whose size changed returns `errorCode: "size_mismatch"`. A mismatch
returns `match: false`, `diffRatio`, and `diffImagePath`, a PNG that marks the
differing pixels.

### prototype

On Android, `show replaceOthers: false` retains other prototype windows (requires
`prototype_multi_surface_v1`), up to four distinct ids; a fifth is refused listing the shown ids.
A same-id show with false replaces only that prototype; omitted or true replaces the other ids.
`dismiss {id}` removes one, `dismiss {all: true}` removes all, and `status` lists every shown id.
`inspect` reconciles the full list. iOS shows one prototype at a time and refuses false.
See [multiple surfaces (phase 1)](design-docs/plat/android/prototype-ux.md#multiple-surfaces-phase-1).

Data, `repeat.items {path}`, `repeat.key`, `{data:/pointer}` text and `{data: pointer}` conditions
require `prototype_data_model_v1`; the host refuses an unsupported device before uploads or show. Text field options (label, variant, supportingText, keyboardType, secure, multiline, minLines, maxLines, maxLength) similarly require `prototype_text_field_options_v1`; without it nothing is shown.
require `prototype_data_model_v1`; the host refuses an unsupported device before uploads or show.
`onLongPress`/`onDoubleTap` on box/row/column/text/image/icon/card require
`prototype_gestures_v1`, with the same refusal before uploads or show.
`swipeActions` on a row or listItem requires `prototype_swipe_actions_v1`, with the same refusal.
textField `trailingIcon`, `imeAction` and `onSubmit` require `prototype_text_field_actions_v1`, with the same refusal.
`carousel` nodes and `pager.indicator` require `prototype_carousel_v1`, with the same refusal.
textField `leadingIcon` requires `prototype_text_field_leading_icon_v1`, with the same refusal.
`scroll.refresh` (`{stateKey, onRefresh}`, pull-to-refresh on a vertical scroll) requires
`prototype_refresh_v1`, with the same refusal.
`setData`, `appendData` and `removeData` actions (a tap changing `/data`, with a `change` event per
write and `baseRevision` required for later `/data` patches) require `prototype_data_actions_v1`,
with the same refusal; see [data actions](design-docs/plat/android/prototype-ux.md#data-actions-12519).
A root-level `storage` block (`{version, keys: ["state:darkMode", "data:/cart"]}`) makes the device keep
those values per prototype id across shows, requires `prototype_storage_v1` with the same refusal,
and is reported by `inspect` as `storage` per prototype. Stored values replace the spec's on the next
show of the same id unless `version` changed; `clearStorage {id}` wipes them and `deleteSaved` also
clears them; see [storage](design-docs/plat/android/prototype-ux.md#storage-12522).
`request` actions (an HTTP call to any http(s) URL from a tap, written into `/data` with a
`statusKey` lifecycle, `onSuccess` / `onError` lists and a `prototype_request` emit event) require
`prototype_network_v1`, and `prototype_network_device_v1` as well for `via: "device"`, with the same
refusal; see [the request action](design-docs/plat/android/prototype-ux.md#request-action-12523).
Data is nested content the agent supplies and state is user-owned scalars. Rendering bindings
(`{data:/pointer}` text, `{data: pointer}` conditions, `repeat` rows) resolve against the current data
whenever it changes, starting with the show; action bindings (`request` url, headers, query and body,
`setData` values, emit context) are read at the moment the action runs, after the earlier actions in
the list have committed. The device may write data (`setData`, `appendData`, `removeData`, a request
`into`), so patches to `/data` follow the `baseRevision` rule above. `status` remembers shown data
beside state, `inspect` reports and adopts it, and dismiss clears it. See the [data model contract](design-docs/plat/android/prototype-ux.md#data-model-11673).

The `prototype` tool (Android and iOS simulators) is omitted from discovery by default. Enable it
with `setToolEnabled { toolName: "prototype", enabled: true }`. Its `action` is
`show`, `patch`, `dismiss`, `status`, `inspect`, `awaitEvent`, `save`, `listSaved`, `deleteSaved`, or `clearStorage`. `show` requires a full `spec` (id,
window, optional data and state, root) and always renders the whole spec. Instead of an inline
`spec`, `show` accepts `specPath`, the absolute path of a local JSON file with the same spec
(exactly one of the two): the daemon reads it, refuses a file over the spec byte limit (1 MiB)
before reading it, validates it like an inline spec, and names the file in every error.
The path is never sent to the device. A spec holds up to 2000 nodes, and a `repeat` up to
128 items. `dismiss`
requires either `id` or `all: true`. `spec.window.opacity` is an integer
percentage from 0 to 100, default 100; show the spec again to change it.

Android saved prototypes require `prototype_saved_v1`: `save` takes `spec`, optional `assets`,
`label` (defaults to `spec.id`, 1–120 characters) and `icon` (an asset uploaded in the same call).
`listSaved` reads saved entries; `deleteSaved` requires `id`. A missing Android capability
returns `unsupported_capability`. On iOS simulators these actions use the host installer,
without a prototype agent connection. Physical iOS devices return `unsupported_platform`.
The viewer template comes from the verified release asset, or from `AUTOMOBILE_IOS_PROTOTYPE_VIEWER`
(build it with `scripts/ios/prototype-viewer-build.sh`).
The same `icon` asset id uses bytes uploaded in `assets` in that call; omit it for the default icon.
iOS `listSaved` returns bundle ids (accepted by `deleteSaved`), labels and slugs, with
`pinned:false` and no `savedAt` because the simulator cannot recover the save time.
`deleteSaved` also accepts the authored prototype id on iOS.
On Android, `save` with `pin:true` then asks the launcher to pin a home-screen shortcut and
reports `pinned`: `pinned` (already on the home screen), `pending` (the launcher's "Add to home
screen" dialog is open; the icon exists only once a person accepts it, and declining sends no
signal) or `unsupported` (the default launcher cannot pin; the prototype is still saved). A
`device_locked` or `pin_failed` pin error returns `success:false` with `saved` kept, so retrying
the same save is safe. `autoConfirm:true` (needs `pin`) waits up to 5 s for the launcher dialog, taps its
"Add to home screen" button (a bare "Add" only beside "Cancel"; Cancel is never tapped) with
`adb shell input tap`, and reports `pinned` only once `listSaved` shows the shortcut pinned. Otherwise
it stays `pending` with a reason (`confirmation_unrecognized` lists the dialog's buttons). Matching is
by English label; resource-id and Samsung matching are not done yet (#12266). `deleteSaved` disables the shortcut; the disabled icon
stays on the home screen. With `removeIcon:true` the host runs `cmd shortcut clear-shortcuts` for
CtrlProxy only when no saved prototype remains, because that command clears every CtrlProxy
shortcut; otherwise the response says the icon remains and can be removed by hand. On iOS,
`pin` is ignored (`pinned:"unsupported"`): the app icon is on the home screen, deleting the
prototype removes it, and `removeIcon:true` warns that separate icon removal does not apply.
Store failures return actionable errors with `errorCode`:
`invalid_id`, `invalid_label`, `spec_too_large`, `invalid_spec`, `invalid_asset_id`,
`duplicate_asset_id`, `unsupported_mime_type`, `empty_asset`, `asset_too_large`, `count_limit`,
`total_limit`, `missing_asset`, `saved_count_limit`, `storage_failure`, `unsupported_existing`,
`not_found`, `unsupported_format`, or `internal_error`.

A `show` whose `spec.id` is the prototype already on screen replaces it in place:
it stays on the display it is on, and each pager keeps its current page (matched
by pager id, clamped to the new page count). The new spec's `state` is
authoritative: values the user changed by tapping or typing are not carried
over unless the spec includes them, and the rebuilt tree starts any text field
from the spec's value. `reset: true` starts it fresh instead: pages come from
the spec and `display` is resolved again. A show with a different id, or with
nothing on screen, replaces any other prototype by default (`replaceOthers: false` retains them). A CtrlProxy that
predates in-place replacement ignores `reset` and always starts fresh.

Two optional window fields need a CtrlProxy advertising
`prototype_window_options_v1`; an older one is refused before anything is sent.
`spec.window.layer` is `system` (default; an accessibility overlay above system
UI) or `app` (an application overlay just above apps, so the notification shade,
keyboard, toasts and the screenshot flash and preview draw over the prototype,
and the status and navigation bars draw over a fullscreen one). Before an `app`
show the daemon runs
`adb shell appops set dev.jasonpearson.automobile.ctrlproxy SYSTEM_ALERT_WINDOW allow`;
if the permission is still missing the device fails the show with that command.
`spec.window.persistence` is `session` (default) or `device`: the prototype stays
interactive after the last host client disconnects (USB unplugged, adb or the
daemon gone) and after session end, has no idle timeout, and keeps its uploaded
assets. `setPage`, `setState`, text fields and the `dismiss` action keep working
offline. It goes away only through its own close control (the fullscreen dismiss
row or revealed pill on a capable device, or a Close button on sheet and floating windows), an explicit `dismiss`, a
replacing `show`, or the CtrlProxy service stopping. Host-side status and event
buffers are still cleared on session release.

`spec.window.chrome` is `none` (default) or `bar`, fullscreen only, on a device
advertising `prototype_window_chrome_v1`. With `none` the prototype fills the window
including under the status bar; use `safeAreaPadding` on the top edge of a
`topAppBar` or top content. Relative sheet detents use the full window height.
A host-owned two-finger long press (about 1 s) reveals a dismiss pill for 5 s;
tapping it dismisses with reason `user`. `window.persistence: "device"` defaults
to `bar`. Accessibility services can dismiss without the gesture (a dismiss
action on Android, the VoiceOver escape gesture on iOS), and the pill stays
visible while TalkBack, VoiceOver or Switch Control is on. On a CtrlProxy or
iOS agent built before the capability the bar is
kept, explicit `none` is refused before showing, and omitted chrome or `bar`
succeeds. `lastResult.chrome` reports what a successful fullscreen show draws
and is retained in host-local status; it is absent on sheet/floating windows,
dismiss, failed show and adopted prototypes. Agent dismiss, replacing show,
authored dismiss, the session idle TTL and last-client disconnect still work.

With no host connected, a persisted prototype's events (tap `emit`s, page changes,
text input, a close) are kept on the device, the most recent 200, dropping the
oldest and counting what it dropped. They are delivered, oldest first, when a
host connects or on `inspect`, and sequences continue from the device's ledger
with no rewind. `status` is host memory, so after a session release it shows
nothing; `inspect` asks the device which prototypes it is showing and adopts them
(`adopted: true`, with the last known `pages` and `state`), so `status`,
`dismiss` and `awaitEvent` work again. It also returns
`deviceDroppedEvents`. `inspect` needs a CtrlProxy advertising
`prototype_persistence_replay_v1` and is refused with an error naming the flag
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
(default 5000 ms). Validation uses the existing prototype schema and limits
before contacting CtrlProxy. Verify rendering with `observe`; prototype returns
no screenshot. Nodes include box/row/column/flow/grid (flow/grid require `prototype_flow_grid_v1`), text/image/icon/spacer/textField,
Material switch/checkbox/button/radioGroup/listItem/slider/chip/card/iconButton/fab/segmentedButton/topAppBar/divider/badge/progress/dialog/snackbar/timePicker/datePicker
bound to state keys, and scroll/pager/tabBar/bottomNav/bottomSheet; actions are
emit/setPage/setState/toggle/increment/decrement/dismiss.
`emit.context` resolves named state/item/index/page/data/value bindings and requires
`prototype_emit_context_v1` (data bindings also require `prototype_data_model_v1`).
Events return `context`, with `contextTruncated: true` only when the resolved UTF-8 JSON
exceeds the byte budget; the longest fitting prefix is kept.
A spec may also carry a `theme` (light/dark mode, a seed colour, per-role colour
overrides, typography and shapes), per-node `style` and `styleWhen` fields,
`transition` on `visibleWhen` nodes, and a spec-level `motion` of `none` to make
every change instant. Android also accepts element anchors, which place a node on
an app element resolved at `show` time; the result lists the resolved `anchors`.
See the [prototype vocabulary](design-docs/plat/android/prototype-ux.md).

#### Light and dark mode

A shown prototype has one resolved mode, light or dark. The first of these that applies
decides it, on Android and on iOS:

1. `theme.mode` `light` or `dark`.
2. The luminance of the flat `theme.colors.background` override, else `theme.colors.surface`.
3. The first opaque authored background on the root's leading chain.
4. The system setting: the show's `appearance` when it is `light` or `dark`, else the device's
   own setting.

`theme.mode: "system"` asks for the system setting outright and skips steps 2 and 3.

`show` accepts `appearance`: `device` (the default), `light` or `dark`. `light` and `dark` pin
what the system setting means for that one prototype, so a spec with `theme.mode: "system"` or no
mode can be checked in both modes. The device itself and the app behind are not changed; use
`displayConfig` (and restore the `previous` value it returns) to put the app into the same mode.
The override replaces the system setting only (step 4), so it never beats what the spec itself
says. It belongs to the show: a later show of the same id without it follows the device again.
`light` and `dark` need a device advertising `prototype_appearance_v1`; without the flag the
call is refused before anything is sent, with an update hint on Android and a relaunch hint on
iOS. `device` sends nothing and works on every device.

A device advertising `prototype_appearance_v1` reports
`appearance: { mode, source, deviceDark }`. `mode` is `light` or `dark`. `source` names the step
that decided it: `explicit`, `roleLuminance`, `authoredBackground`, `override` or `system`.
`deviceDark` is the device's own setting whatever decided the mode. Only a device answer states it,
and only as of that answer: the `show` result and each `inspect` entry. The host never infers it,
and the host-local `status` action never reports it: the device can flip while a pinned or
authored mode stays put, which sends no event, so a remembered value could be wrong. Call
`inspect` for the current one. A successful `show` returns the object in `lastResult`, and
`inspect` returns it on each prototype; `status` returns `mode` and `source` only. The field is
absent when the device lacks the flag, on `dismiss` and on a failed show; a failed same-id show
keeps the `mode` and `source` of the prototype still on screen. If an `appearance_changed` event
arrives while a show is in flight the host cannot order the two, so that status entry has no
appearance until a later event or `inspect` states it.

While a prototype is shown it follows the device live. On any change of the resolved mode (the
device flipping, or prototype state changing a background the mode is inferred from) the device
sends one `prototype_event` with `kind: "appearance_changed"`, `name: null` and
`payload: { mode, source }`. Nothing is sent when the mode stays the same, nor for the show
itself. Wait for it with `awaitEvent` and `kind: "appearance_changed"` (its `name` is null, so
`eventName` does not match it). The event also refreshes the `appearance` that `status` reports:
`mode` and `source` come from the event. `deviceDark` is not part of `status` at all (see above);
the next `show` result or `inspect` states it.

In a scrim slot (`window.placement.scrim`, a bottomSheet `scrim`) only the `scrim` role is drawn
translucent, at 0.4 alpha; any other role is drawn unchanged. The per-mode forms
(`{light, dark}` colour and image pairs, role names in gradient stops and scrims,
`theme.colors.light` / `theme.colors.dark`) need a device advertising
`prototype_theme_modes_v1`.

Optional pager `axis` (horizontal default or vertical), `pageSpacing` (dp gap),
strict `peek: {start?, end?}` and `pageSize` (`"fill"` default or strict `{dp}`)
require `prototype_pager_options_v1` whenever explicitly present. Spacing and peek
are finite 0..10000; fixed page size is finite 1e-6..10000 (`MAX_PROTOTYPE_PAGER_DP`).
Missing spacing/peek sides mean 0, and `{}` peek is a no-op. Units are points on iOS.
A vertical pager cannot have any vertical scroll ancestor (omitted axis is vertical), and a horizontal pager or a carousel cannot have any horizontal scroll ancestor.
Current page is the first fully visible page; page events and navigation bindings
keep their meaning. Every visible page (including partly visible peek and fixed-size pages) is exposed to accessibility, observe and tapOn; Android marks the current page selected only for pagers with positive peek or a fixed pageSize; iOS marks it selected on the options path (a pager with any non-default option) and not on the legacy paged pager; plain pagers expose only the current page on both. Pages fully off-screen are not exposed.

### Patch (#11675)

Use `show` for a new screen or a window, theme or root change. Use `patch` for
content (`/data`), state (`/state`) or one node by id (`replaceNode`) of the shown prototype. Android CtrlProxy advertises
`prototype_patch_v1` and applies patches in place; the iOS prototype agent advertises it too
(a relaunched app loads the current agent), so an older agent still needs the whole spec with `show`.

`{action:"patch", id, ops, baseRevision?}` sends a `patch_prototype` frame
`{requestId, id, baseRevision?, ops}` only to a device advertising
`prototype_patch_v1`. Android and iOS use `prototype_result` replies. Success
carries `revision`; a state conflict carries
`{success:false,error,conflict:{revision,state:{key:scalar}}}`. Revisions are
non-negative safe integers; conflict values are strings, booleans or finite
numbers with valid state keys. Malformed reply fields are dropped. Show, status,
inspect and events do not report revisions through this host contract.

Ops apply in order, completely or not at all. `add`, `replace`, `remove` and
`test` address `/data` or `/data` followed by an RFC 6901 JSON pointer: `~0`
escapes `~`, `~1` escapes `/`; array indices are canonical non-negative decimal
integers, and `-` appends for `add` only. Parent paths must exist. `replace`,
`remove` and `test` require the addressed value to exist. `add`, `replace` and
`test` carry `value`; `remove` does not. State ops address exactly
`/state/<key>`, where keys match `[A-Za-z_][A-Za-z0-9_]{0,63}` and values are
strings, booleans or finite numbers.

`replaceNode` carries `{op:"replaceNode",id,node}`. The id must identify exactly
one node in the tree, cannot be the root or inside a repeat, and the replacement
must keep that id. Replacement nodes cannot contain `use` nodes or element
anchors. Inline the component, use a bounds anchor, or use `show`.

The agent writes data; the user writes state. Data-only patches and patches
containing only data ops and `replaceNode` ignore `baseRevision`. Any state op,
including `test`, requires `baseRevision`. A device supporting the capability
must refuse the whole patch with `conflict` if the user changed a touched state
key since that revision, returning the current revision and those keys' values.

There are at most 64 ops, the frame is capped at 1 MiB, and the resulting whole
spec must satisfy every spec/data limit, including node count and depth. The
host tracks a cloned copy of each id's device spec from its last acknowledged show,
with components expanded and anchors resolved. It applies ops to a copy and
runs the full validator before sending. Errors preserve deterministic paths.
The host validates state ops against the agent-declared state and leaves value
comparison for `/state` `test` to the device; its copy cannot know user edits.

Patches are FIFO per device, with one in flight at a time. A pending show makes
patch refuse as busy. Shows are not delayed by patches. If a dispatched show
and an acknowledged patch overlap, their device-side order is unknown: the host
forgets its spec, warns, and requires a further successful show before patching.
A failed dispatched show, dismissed event, successful dismiss, session release,
device removal or unbinding also ends tracking. Inspect retains each reported tracked id
and drops missing ids; adopted siblings do not end its tracking. A fifth-surface refusal
with `replaceOthers: false` also retains the acknowledged specs. A timeout or connection loss after
patch dispatch is indeterminate and requires a new show. A failure before dispatch
keeps the tracked copy. An atomic device
refusal leaves the tracked copy unchanged. A successful patch refreshes shown
status data without changing `lastResult`, timestamps or event snapshots.

#### iOS simulators

On iOS simulators `prototype` is backed by a prototype agent injected into the app at launch
(`launchApp { prototype: true }`), with no SDK in the app. It works on simulators only, only for
apps launched with the agent (a relaunch loses app state; SpringBoard is not covered), and
offers `show`, `dismiss`, `status` and `awaitEvent`; showing
the same `id` again updates the prototype. For apps run from Xcode, add `DYLD_INSERT_LIBRARIES`
to the scheme. See the [iOS prototype agent](design-docs/plat/ios/prototype-agent.md).

`show` accepts the same optional `display` selector as the tap tools (a panel
key, a role such as `inner` or `cover`, or `active`), resolved with the same
precedence: an explicit `display`, then the session display pin, then the default
display. Omitting it sends no display and behaves exactly as before. A resolved
non-default display is sent as the panel's logical `displayId` and needs a
CtrlProxy advertising `prototype_display_id_v2`; an older APK is refused with an
error rather than showing the prototype on the default display. An unknown or
disconnected panel is refused with the usual disconnected-panel guidance. If the
panel disappears while the prototype is up (fold), the device dismisses it with
reason `teardown`; it is never moved to another display. `dismiss` acts on the
prototype where it is shown and does not take `display`. A same-id `show` without
`reset` keeps the display the prototype is on: a `display` (explicit or from the
session pin) that resolves elsewhere is ignored, and the result carries a
`warning` saying so; pass `reset: true` to move it.

`display` and `assets` combine on `show`: the display is resolved and checked first, so a
refused display uploads nothing; assets are then uploaded and the prototype is shown on that
display. The one missing-asset re-send goes to the same resolved display without re-reading the
display inventory. A same-id `show` with `assets` stays on the display the prototype is already on.

`show` accepts `assets`: an array of `{ id, path }`
or `{ id, observation }` that uploads images (or, with `path`, TTF/OTF fonts) before the prototype is sent, so no
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
answered, reported as indeterminate) fails the call before the prototype is shown
or replaced; the error and `uploadedAssets` name the assets already stored, which
stay on the device until the prototype session ends and are replaced if the call is
repeated. On success `uploadedAssets` lists each `{ id, mimeType, bytes }`.

When the device accepts a `show` but lists referenced asset ids it has
no copy of, the result stays successful and adds `missingAssets` (the ids; absent
when none) and a `warning` naming what to upload. If the same call supplied
`assets` for some of those ids (the upload-then-cleared race), they are
re-uploaded from the bytes already read and the prototype re-sent exactly once; the
result is the re-sent one. A retry that fails, or a cancelled request, keeps the
first result and says so in `warning`. The MCP request deadline grows by 15 s per
asset plus the request's `timeoutMs` (default 5000 ms), doubled for that one
retry, plus 10 s per `observation` source for a capture still in flight, and
30 s of headroom.

`status` performs no device request. It reports only prototypes successfully
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
`state`, and `lastKnown: true` from its latest accepted `prototype_event`. These
snapshots survive event consumption and failed show attempts; a successful show (same id or not) clears them
until another event arrives. Requested state is never reported as observed state.
Accepted events are pushed once to telemetry under category `prototype`, with
owning device/session ids, event id, kind, name, sequence, pages and state. This
telemetry is push-only, with no database persistence or historical backfill.
A device-side `dismissed` event removes shown presence across that device's host
sessions. A `page_changed` event has the pager id as `name` and the new zero-based page index as
`payload`, on Android and iOS, so `awaitEvent` with `kind: "page_changed"` and `eventName` set to a
pager id waits for that pager; its `pages` map still carries every pager. `page_changed` events
update the last known snapshot and event bookkeeping, preserving host mutation
status. Raw transport disconnects are not observed; session release, device removal,
and device unbinding clear the corresponding buffers and host status.

`awaitEvent` requires `id`; it waits for one event in the current session/device/id
scope. Optional `eventName` (matching `name`), `kind` (`emit`, `page_changed`,
`dismissed`, or `appearance_changed`), and `afterSequence` (a nonnegative integer, strictly exclusive cursor)
are valid only for `awaitEvent`.
Input and state changes (text input, toggles, sliders etc.) arrive as kind `emit` with `eventName` `change` (there is no separate `change` kind), with payload `{key,value}` for one changed key or `{keys,values}` for several. An event of a kind this host does not know (a newer device) is
logged and skipped: it is never returned, but its sequence still counts toward `lastSequence`. Its `timeoutMs` defaults to 30000 ms and cannot
exceed 60000 ms; the MCP request deadline for an `awaitEvent` call is that wait plus 30 s of
headroom, so a quiet wait ends with `timedOut: true` rather than a transport timeout. Request cancellation preserves the abort reason and removes the
waiter's timer and abort listener. When the client supplies an MCP progress callback,
wait start/finish notifications are best-effort and do not delay event delivery. Background subscriptions for shown prototypes
remain active to buffer events between calls.

The result is `{ success: true, event, pendingCount, lastSequence, droppedCount }`,
with `event` containing `id`, `sequence`, `kind`, `name`, `payload`, `state`, `pages`,
and `timestamp` (device clock milliseconds). If the wait expires, it returns
`success: true, timedOut: true` with counts and no event. If the scope ends without
a matching event, it returns `success: true, reason: "dismissed"` with counts.

The exported `PROTOTYPE_EVENT_BUFFER_CAPACITY` is 64 events per scope. Overflow drops
the oldest event and increments `droppedCount`; that count is cumulative until
explicit dismiss or scope release. Calls consume one matching event; excluded events
remain pending, including those skipped by a cursor. Accepted events are ordered
by sequence. Lower-or-equal sequences are ignored across reconnects, including
previously unseen late lower arrivals; this implements the wire high-water rule.

Because pushes carry no session id, the latest show of a device/id owns its events;
awaiting that id from another scope is rejected until it is shown in that scope.
Awaiting an unknown id can establish ownership without a show; an unused scope is
removed on timeout/abort. Multiple prototypes on a device share one subscription.
Explicit successful dismiss (id or all) clears buffers across that device's host
sessions. Each show, including a same-id show, starts a fresh sequence epoch for that id: pending events and the
sequence high-water mark are cleared (the device's sequence ledger is in memory, so a
CtrlProxy restart restarts a re-shown id at 1), while the cumulative `droppedCount`
is kept until explicit dismiss or scope release. Events carry only id, sequence and
timestamp, so a late event from the previous showing cannot be told apart from the new
showing's and is accepted if it arrives after the new show. A successful show of
another id replaces other prototypes by default (`replaceOthers: false` retains them): the replaced prototypes' waiters settle with
`reason: "dismissed"` and its buffers are removed. A terminal `dismissed` event remains
buffered until consumed or the next explicit show/dismiss. Consuming it clears all
remaining pending events and, once no waiter remains, removes the entry, so a later
await behaves as for an unknown id (it waits, then times out). Session release clears
the buffers, waiters and subscription of every scope on each device the release
clears from host status, so event state and status never disagree.
The device subscription ends when no nonterminal prototypes remain.

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

A read never writes settings on a device it does not hold, with one exception: readiness needed to answer the read.
A sessionless read that names a running device nobody holds may ready it in order to answer: on Android it may
install the CtrlProxy APK, write the accessibility settings, and force-stop and rebind the service; on an iOS
simulator it may install and launch the runner. The exception never applies to a device held or
reserved by another session: those reads use what is already installed and never run readiness.
(Owner decision 2026-10-12, #11964.) See
[Which read tools ready an unheld device](using/device-ownership.md#which-read-tools-ready-an-unheld-device)
for the per-platform registry readiness table and `observe`'s separate service-start path.

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
| `runner_unavailable` | Android: `Automatic CtrlProxy recovery is exhausted/suspended after N attempt(s); last failure: ...`                                                                                                                                                  | Automatic recovery will not run again; run `startDevice` or begin a new session to rearm it.                                                                                  |
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

| Tool                          | What it does                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📍 <code>tapAt</code>         | Taps screen coordinates or a point measured in an observation image; supports long press and double tap, and a stylus `pointer` on Android 12+.                     |
| 👆 <code>tapOn</code>         | Taps by text, content description, resource ID, or Android test tag; supports nested containers and first/random/unique selection; can ensure toggle state.         |
| 🎯 <code>tapAny</code>        | Taps any clickable element, optionally scoped to nested containers; supports first/random/unique selection.                                                         |
| 👉 <code>swipeOn</code>       | Swipes or scrolls the screen or an element; container and lookFor support nested scopes and first/random/unique selection.                                          |
| ↗️ <code>swipeAt</code>       | Swipes between two screen points, including diagonals, optionally with a stylus `pointer` on Android 12+; opt-in with `setToolEnabled`.                             |
| ↔️ <code>dragAndDrop</code>   | Drags one element to another; each endpoint supports nested containers and first/random/unique selection.                                                           |
| ✍️ <code>dragPath</code>      | Drags one finger along a polyline with per-segment timing, an initial hold and a release hold (Android and iOS).                                                    |
| 🤏 <code>pinchOn</code>       | Pinches to zoom, optionally scoped by nested containers.                                                                                                            |
| 🖐️ <code>multiTouch</code>    | Simultaneous 2-5 finger tap, long press, or swipe: `action`, `fingers`, `x`/`y`/`coordinateSpace`, `direction`, `distance`, `fingerSpacing`, `durationMs`, `layer`. |
| ⌨️ <code>sendKeys</code>      | Runs ordered text, clear, raw-key, and semantic-key commands.                                                                                                       |
| 🧩 <code>setUIState</code>    | Sets multiple form fields to a desired state.                                                                                                                       |
| ✨ <code>selectAllText</code> | Selects all text in the focused input.                                                                                                                              |
| 🔘 <code>pressButton</code>   | Presses a device or navigation button. iOS simulators support volume and power; iOS does not support menu.                                                          |
| ⌨️ <code>keyboard</code>      | Opens, closes, or detects the keyboard; selects AutoMobile profiles or installed Android IMEs.                                                                      |
| 📋 <code>clipboard</code>     | Copies, pastes, clears, or reads the clipboard.                                                                                                                     |

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
`pinchOn`, `tapAt`, `swipeAt`, `selectAllText`, and `identifyInteractions` accept an optional top-level `layer`
(`"app"` or `"prototype"`) that scopes the call to one layer of the screen. `app`
excludes AutoMobile's own prototype window; `prototype` keeps only prototype nodes and
fails with an actionable error when no prototype is showing. Omit it to search both,
topmost first. `observe` applies it to the returned hierarchy and to `waitFor`
element conditions. `identifyInteractions.layer` analyzes only that layer's
elements. `dragAndDrop.layer` scopes both the `source` and the `target`
drop-target resolution; `swipeOn.layer` scopes `container`, auto-target, and
`lookFor` resolution; `pinchOn.layer` scopes `container` and auto-target resolution.
With `layer: "app"`, an Android CtrlProxy that advertises
`screenshot_hide_prototype_v1` hides its prototype for the `observe` capture: it hides
the window, waits for a rendered frame, captures and restores, all on the device in
one request, so a cancelled observe never leaves the prototype hidden. While an
prototype is showing, the result then reports `screenshotIncludesPrototype: false`; a
capture that cannot confirm the hide fails instead of falling back to ADB. Older
CtrlProxy builds, iOS, and `deviceId` reads (which capture through ADB) still
include the prototype in the screenshot or crop, and the result says so with
`screenshotIncludesPrototype: true`. Navigation-graph
screen identity always uses the app's windows only, so showing, paging, or
dismissing a prototype records no navigation.

Touches go to the window under the point where a finger goes down, so gestures
are checked there before dispatch: the tap point (`tapAt`, `tapOn`, `tapAny`), the
swipe start (`swipeOn`, `swipeAt`), both finger start points (`pinchOn`), and both drag
endpoints (`dragAndDrop`). With `layer: "app"` a gesture whose point lies under an
prototype window is refused. With `layer: "prototype"`, `tapAt`, `swipeOn`, `swipeAt`, and
`pinchOn` also refuse a point outside every prototype window, because it would
reach the app. There is no touch-through mode: hide or move the prototype to reach
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

#### Android IME result check

When the CtrlProxy APK reports the inserted text, the host compares it with the
request. Other differences report `partialApplication` with the actual inserted
text. These editor transformations are allowed:

- NFC spelling; optional delimiters of real inline-format spans in the request
  (see the grammar below). All other markers are required literal text.
- A line-start block shortcut consumed or replaced by a list marker.
- Case and decimal-digit input filters.
- Input-mask additions of characters that are not letters, digits, or marks.
- Mention chips and code fences use a looser in-order check.
- With device success, exactly one final `\n` consumed as the editor's submit
  action. A request ending in two newlines must still show the first; a newline
  missing mid-text fails. CRLF and CR receive no special treatment. For a lone
  `\n`, the inserted text must contain no letter, digit, or mark.

Inline-format spans are evaluated on the request after NFC normalization and
line-start block-shortcut removal (`/^(>|[-*•+]|\d+[.)]) /gm`), so the `*` in
`* item` is never a span delimiter. A span is `D content D` with the same
delimiter on both sides:

- `D` is a backtick (code), `**` (bold), `~~` (strike), `*` (bold), `_` (italic),
  or `~` (strike). Code fences (` ``` `) keep the looser fallback above.
- Content has one or more characters, contains no `\n` or occurrence of the
  delimiter's marker character, and neither starts nor ends with whitespace.
- Delimiter runs are exact: the opening delimiter is not immediately preceded
  by the same marker, and the closing delimiter is not immediately followed by
  it. Thus `***x***`, `__x__`, and ` ``x`` ` contain no span; `**x**` is one
  double-asterisk span, not a single-asterisk span.
- The opening delimiter is at the start or follows a character that is not a
  letter or digit (`[\p{L}\p{N}]`); the closing delimiter is at the end or
  precedes a character that is not a letter or digit. This applies to all six
  kinds, so intraword markers are literal.
- Each kind scans independently left to right over the whole request. Different
  kinds may nest (`*_x_*` contains both pairs). Every span's delimiter characters
  are optional, but the number of matched opening characters must equal the
  number of matched closing characters for that span. `*bold*` may become `bold`
  or stay `*bold*`, but cannot become `*bold` or `bold*`; `**x**` may become `x`,
  `*x*`, or stay `**x**`.

Non-code markers inside a backtick code span are literal; a non-code span with either delimiter inside code cannot convert.

For example, `*bold*`, `_italic_`, `~strike~`, and `` `code` `` may lose their
paired markers. The literal markers in `john_doe@example.com`, `snake_case_name`,
`2 * 3`, `~/path`, and ``it`s`` must be inserted exactly, subject to the other
allowances above. Inserted markers are never stripped: they match a request
token or count as input-mask additions. A plain editor keeping `*bold*` passes,
as does inserting `*bold* _code_` for `bold code`. Requests containing only the
four marker characters remain unverifiable and match, since a lone closing
marker typed by a separate call cannot be predicted. After forgiving a final
newline, the remaining request goes through this same span-aware comparison.

A submit-and-clear composer also succeeds immediately when the device reports
success, the inserted text is exactly empty, and the readable focused field is
empty after a request ending in `\n`. Older APKs that omit inserted text retain
the whole-field check: a retained query can pass, but a cleared composer fails.

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
a plain pinch. Android and iOS share this convention. The value must be
between <code>-360</code> and <code>360</code> degrees; larger magnitudes are rejected.

To rotate **without zooming**, keep the finger distance constant: pass
<code>scale: 1</code> (or equal <code>distanceStart</code> and <code>distanceEnd</code>)
together with <code>rotationDegrees</code>. <code>direction</code> is still a required
argument but is ignored when the distance does not change, so the fingers never
drift toward a zoom; equal distances are clamped and (on iOS) rounded together
so they stay equal. Negative values are passed through as given. This is a
two-finger rotate gesture, not the device <code>rotate</code> tool, which changes
screen orientation.

```json
{ "direction": "out", "scale": 1, "rotationDegrees": 90, "duration": 500 }
```

</details>

### dragPath

`dragPath` is disabled by default; enable it with `setToolEnabled`. It drives one
finger down, along a polyline, and up using the CtrlProxy streaming stroke
protocol, so it covers signatures and drawing canvases, Android unlock patterns,
dragging a slider thumb to a coordinate, and long press then drag (for example a
text-selection handle). On Android it streams start/move/end frames; on iOS the
runner follows the whole timed path in one request (private XCTest touch
synthesis, main display only), which needs a runner built from this revision
(feature `path_gesture_v1`) and fails before any input on an older one.

- `points`: 2 to 100 `{ x, y, durationMs? }` vertices. `durationMs` (1 to 5000,
  default 200) is the time spent moving from the previous point to this one and
  is ignored on the first point. Long segments are sent as moves at most 50 ms
  apart.
- `holdMs` (0 to 3000, default 0): press and hold at the first point before
  moving. `releaseHoldMs` (0 to 3000, default 0): keep the finger down at the last
  point before lifting.
- `coordinateSpace` (`absolute` default, `normalized`, `percent`), `snapshotId`,
  `display` and `layer` behave as in `tapAt`. Every point must lie inside the
  screen; the first bad point is named in the error and nothing is dispatched.
- Total finger-down time (holds plus segments) is capped at 20 seconds and must
  fit the remaining request budget with 2 seconds of headroom; otherwise the call
  is rejected before any input.
- An aborted, timed-out or failed call always lifts the finger with a cancelling
  end. A failure after the finger went down reports that the stroke may have
  partially run; observe before retrying.

```json
{
  "points": [
    { "x": 0.2, "y": 0.3 },
    { "x": 0.2, "y": 0.7, "durationMs": 400 },
    { "x": 0.8, "y": 0.7, "durationMs": 400 }
  ],
  "coordinateSpace": "normalized",
  "holdMs": 100
}
```

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

| Tool                                                                                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📱 <code>listApps</code>                                                                         | Lists installed apps with optional label/launchability when reported (`device`, `type`, `search`, `profile`; default `type=launchable`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 🚀 <code>launchApp</code>                                                                        | Launches an app by package name. On iOS, optional `launchArguments` start a fresh process and pass argv after the bundle ID. DEBUG storage writes require a launch-scoped mutation token; the daemon supplies it when `--allow-storage-mutations` is present. Android rejects launch arguments and takes an `intent` instead; an app already in the foreground is a success flagged `alreadyForeground` unless an `intent` was given. On iOS simulators, `prototype: true` relaunches the app with the prototype agent injected (state is lost); physical iOS, Android and `com.apple.*` apps reject it. |
| ❌ <code>terminateApp</code>                                                                     | Terminates an app by package name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 💥 <code>crashApp</code>                                                                         | Intentionally crashes a running app through the platform crash path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ♻️ <code>appLifecycle</code>                                                                     | State-preserving background-process kill for saved-state restoration tests (Android only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 📦 <code>installApp</code>                                                                       | Installs an APK, app bundle, or IPA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 🗑️ <code>uninstallApp</code>                                                                     | Uninstalls an app by package name or bundle identifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 🔏 <code>inspectPackageSigning</code>                                                            | Fresh read of an app's presence (`installed`, `absent`, `unknown`) and signing. Android: one user's SHA-256 signer set and rotation history. iOS Simulator and physical: team, signing identity, CDHash, entitlements and the embedded provisioning profile. Never cached.                                                                                                                                                                                                                                                                                                                               |
| 🔗 <code>getDeepLinks</code>                                                                     | Queries an app's deep links. On Android 12+ it also returns `appLinks`: per-domain App Links verification state and user selection (see [App Links verification](#android-app-links-verification)).                                                                                                                                                                                                                                                                                                                                                                                                      |
| 📄 <code>putAppFile</code>                                                                       | Writes local-file, UTF-8, or base64 fixtures through one target/files contract: private app_containers, bounded platform-qualified user_files, or media_library. Default-enabled for every storage target; see the canonical call shape below.                                                                                                                                                                                                                                                                                                                                                           |
| 🧾 <code>resetAppLogs</code>                                                                     | Resets explicitly named app-container log files and their rotated siblings on the session device, with per-path outcomes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 📁 <code>stageSessionDownloads</code>                                                            | Deprecated session-bound alias of putAppFile target.domain user_files (Android Downloads); retains session ownership checks and remains until equivalent workflows are device-verified.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ⚙️ <code>getPreference</code> / ⚙️ <code>setPreference</code>                                    | Reads or writes Android system properties, SharedPreferences, or iOS UserDefaults. On iOS, requires `appId` and selects the store with `suite` (not `name`/`fileName`); omitted/`Standard` uses the default store. Uses an already connected embedded SDK, with simulator plist fallback when permitted.                                                                                                                                                                                                                                                                                                 |
| 🔑 <code>setKeyValue</code> / 🔑 <code>removeKeyValue</code> / 🔑 <code>clearKeyValueFile</code> | Manages an app key-value storage file. For iOS, an empty `name`, "standard" (any case), or the app bundle id selects standard UserDefaults; other names select a valid suite. Names must have no leading or trailing whitespace. Android uses a SharedPreferences file name without `.xml`. iOS write results include `resolvedStore` when supported by the SDK and runner. `setKeyValue` returns `effectiveValueDiffers: true` and appends a warning when the write persisted but the app reads a different effective value due to an override; remove/clear never produce this warning.                |
| 🗃️ <code>listDataStores</code> / 🗃️ <code>getDataStore</code>                                    | Lists or reads Android Jetpack DataStore entries with the SDK adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 🗄️ <code>sqlQuery</code>                                                                         | Executes SQL against an app SQLite database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 🔐 <code>resetKeychain</code>                                                                    | Resets all Keychain data on an iOS Simulator after explicit confirmation; unsupported on Android and physical iOS devices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ✅ <code>setAppLinks</code>                                                                      | Android 12+: approves, resets, or re-verifies an app's App Links domains, or changes a user's domain selection, so https links open the app without a chooser. Returns what changed and a restore receipt; a daemon session restores the original state on release.                                                                                                                                                                                                                                                                                                                                      |
| ⏱️ <code>measureStartup</code>                                                                   | Android: launches an app N times cold, warm or hot and reports time-to-initial-display (TTID) and, when the app calls `reportFullyDrawn`, time-to-full-display (TTFD) percentiles. Stored in `automobile:performance-results`.                                                                                                                                                                                                                                                                                                                                                                           |
| 📜 <code>getLogs</code>                                                                          | Reads filtered device logs: Android logcat for every process of an app (crashes survive process death), with tag, priority, regex and buffer filters, since the last action or session start; iOS Simulator unified log by app subsystem.                                                                                                                                                                                                                                                                                                                                                                |
| 📡 <code>sendBroadcast</code>                                                                    | Android: sends an explicit broadcast with a typed intent to the app under test and reports the ordered-broadcast result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

<details class="note" markdown="1">
<summary>Measuring startup with measureStartup</summary>

<code>measureStartup</code> (Android only, off by default; enable it with
<code>setToolEnabled</code>) measures one launch per iteration with plain
<code>am start -W</code> calls. It never runs <code>launchApp</code>, observation or UI
settling during the run, so AutoMobile adds no work of its own to the measured launch.

- `appId`: the package to launch.
- `activity`: an activity class (`.MainActivity`) or a full `pkg/.Activity` component.
  Omitted, the launcher activity is resolved with `cmd package resolve-activity`.
- `mode`: `cold` force-stops the app before every launch; `warm` keeps the process
  but clears the task so the activity is recreated; `hot` presses Home and brings the
  existing activity back. Warm and hot runs start with one unmeasured launch.
- `iterations`: launches to measure, 1–50 (default 5).
- `compilation`: `asIs` (default) or a `cmd package compile -m <mode> -f` mode
  (`speed-profile`, `speed`, `verify`) applied once before the run.
- `dropCaches`: cold only. Drops the page cache before each launch through a root
  shell (`adb root` or `su`); refused when the device has neither.
- `waitForFullyDrawn`: wait up to 10 s after each launch for the app's
  `Fully drawn` log line. Without it, the log is read once per launch.

The result has `ttid` (from `TotalTime`) and, when any launch logged
`Fully drawn`, `ttfd`, each with `min`, `p50`, `p90`, `max` and the per-launch
`samples`. `launchState` lists what `am start -W` reported per launch (`COLD`,
`WARM`, `HOT`; `UNKNOWN` before API 29) and `waitTimeMs` the matching `WaitTime`.
`warnings` explains a missing TTFD, launches without a `TotalTime`, and launches
whose state differs from `mode`. Each run is stored in
`automobile:performance-results` with the TTID p50 as `timeToFirstFrameMs`, the
TTFD p50 as `timeToInteractiveMs`, and the full result in `diagnostics` (`kind:
"startup"`), so runs can be compared over time.

</details>

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

### getLogs

`getLogs` returns bounded, filtered log lines as structured data (#14082). Use it
when a step fails and you want to know why. It reads the same sources as the
`automobile:device-session/{sessionUuid}/apps/{appId}/logs` resource, without
needing an MCP resource read.

- `appId` scopes Android logcat to the app's **uid** (`logcat --uid`, Android 11+),
  so lines from a process that crashed or restarted are still returned. Before
  Android 11 it falls back to the app's currently running pids, with a warning
  (`attribution: "pid"`). Without `appId`, every process is read.
- `since` is `"lastAction"` (the start of the most recent control call on the
  device), `"sessionStart"` (the caller's session creation), or `{ seconds }`. The
  default is 300 seconds and the window is capped at 3600. An anchor that is not
  known falls back to the default with a warning. The window is measured on the
  device's own clock.
- `tags` are logcat filterspecs, `"Tag"` or `"Tag:P"`. All other tags are silenced.
  `minPriority` is one of `V`, `D`, `I`, `W`, `E`, `F` (default `V`).
- `grep` is a regular expression matched host-side against `Tag: message`.
- `buffers` picks logcat buffers from `main`, `system`, `crash` and `events`. The
  default is `["main", "crash"]`, so a crash's stack trace is included.
- `includeSystem` adds `ActivityManager`, `ActivityTaskManager` and `AndroidRuntime`
  lines that name `appId` (launches, process deaths, ANRs).
- `maxLines` (default 1000, at most 5000) and a 256 KiB byte bound keep the newest
  lines; `truncated` reports that older lines were dropped.

Each line has `timestamp`, `pid`, `tid`, `priority`, `tag` and `message`, and the
result lists the `pids` seen. On the iOS Simulator, `getLogs` needs `appId`. It
reads the unified log for the app's subsystem (`minPriority` `V`/`D` maps to
debug, `I` to info), applies `grep`, and warns that the Android-only filters are
ignored. iOS lines carry only `timestamp` and `message`.

### sendBroadcast

`sendBroadcast` reaches an app's broadcast receivers, such as the debug receivers
that toggle feature flags, seed data, reset state or fire a push-like event (#14081).
It is Android-only; iOS returns `status: "unsupported"`.

- `appId` is required. The broadcast is always explicit: `-p <appId>`, or
  `-n <appId>/<receiver>` when `intent.component` names a receiver (`.DebugReceiver`,
  `com.app.DebugReceiver`, or `com.app/.DebugReceiver`). A component in another
  package is refused. Implicit system-wide broadcasts are out of scope.
- `intent` takes `action` (required), plus optional `data`, `mimeType`, `categories`
  and typed `extras`: `{ key, type, value }` with `type` one of `string`, `int`,
  `long`, `float`, `boolean`, `stringArray` and `uri`. Every value is shell-quoted,
  so shell metacharacters arrive literally. A comma inside a `stringArray` element
  is escaped for `--esa`.
- `userId` delivers to another Android user (`--user`).
- `waitForResult` (default `true`) reports the ordered-broadcast `resultCode` and
  `resultData` that `am broadcast` prints (`Broadcast completed: result=…`). With
  `false` they are left out; `am` still waits for delivery.
- `am broadcast` reports `result=0` even when nothing received it, so the tool checks
  first: an uninstalled `appId` fails with `package_not_installed`, and an explicit
  `component` that `cmd package query-receivers` does not resolve fails with
  `no_matching_receiver`; nothing is sent in either case (a check that cannot run falls
  through to the broadcast).
- A protected system broadcast (for example `BOOT_COMPLETED`), which the shell may
  not send, fails with `errorCode: "protected_broadcast"`. Other refusals report
  `permission_denied`, and output with no completion line reports
  `broadcast_failed`.

### App launch, installation, links, and storage options

`openLink.url` is the URL to open. `getAppPermissions`, `getDeepLinks`,
`getNotificationPolicy`, `clearKeyValueFile`, and `removeKeyValue` use `appId` for
the Android package name or iOS bundle ID. `clearKeyValueFile.fileName` and
`removeKeyValue.fileName` are deprecated aliases for the store selector `name`.
`setAppPermissions.action` selects `grant`, `revoke`, or `reset`.

On iOS, `getDeepLinks` reads custom URL schemes (`CFBundleURLTypes`) and document
types from the installed bundle's `Info.plist`, and universal-link hosts from the
`com.apple.developer.associated-domains` entitlement (`applinks:` entries). The
Simulator reads its host bundle directly. A physical device (#14094) copies the
installed bundle to the host with `devicectl device copy from` and reads it the
same way, so both report the same links for the same build. A failed copy returns
`success: false` with devicectl's stderr. Physical-device results are cached per
device, bundle ID and installed version, so repeat calls skip the copy until the
app is updated.

On iOS Simulator, a stored TCC Photos grant is not proof of effective full
read/write authorization. `getAppPermissions` reports it as `unknown` with
`verified: false`; by default `setAppPermissions` returns a non-fatal unverified
success with `success: true`, `applied: true`, `verified: false`, a warning, and
`code: "PHOTOS_FULL_ACCESS_UNVERIFIED"` after dispatching a full Photos grant.
An unobservable verifier or a verifier/TCC-readback exception keeps this outcome;
the warning is aggregated in `warnings` and the operation counts as changed.
Only an app-level verifier reporting `authorized` yields `verified: true`, with
no code or warning. A positive `limited`, `denied`, `notDetermined`, or `addOnly`
observation yields `success: false`, `applied: true`, `verified: false`,
`PHOTOS_FULL_ACCESS_NOT_ESTABLISHED`, and an actionable error. For `all`, this
keeps the successful `all` dispatch operation and adds a separate failed `photos`
operation; only the Photos entry counts as failed. Each operation exposes its
own permission in `stepId`, its result, and any code, including non-fatal codes.
A real verifier needs target-app instrumentation (design option C, still a follow-up):
launch the app and check
`PHPhotoLibrary authorizationStatusForAccessLevel:ReadWrite`. Add-only access is
insufficient. Results include `accessLevel` (`readWrite` for Photos and
`addOnly` for photos-add); an unverified stored Photos grant includes
`evidence: "storedTccGrant"`. Granting `photos-add` remains a dispatch success with
`accessLevel: "addOnly"` and does not establish full access. No simulator/runtime
combination is currently verified to give effective full access through
`simctl privacy grant`; simulator verification with the Playground probe is still
owed. This behavior is not device-verified.
On simulator runtimes iOS 27 and later, a full stored Photos
grant (`auth_value: 2`) implies add-only access: photos-add reports `granted` with `evidence: "impliedByFullPhotosGrant"`
when its own row is missing or not granted. A stale PhotosAdd row remains in
`raw` and `authValue` for transparency; an already granted PhotosAdd row is
unchanged. Denied, limited, or unknown Photos rows do not imply add-only access.
On iOS 26.x or an unknown runtime the stored PhotosAdd row is reported as is.
Physical-device permission limits are unchanged.

`resetKeychain` requires `appId` and `confirm: true`. On iOS Simulator the reset
erases every app's Keychain, regardless of `appId`.

`launchApp.coldBoot` starts the app cold instead of resuming it (default false).

On Android, `launchApp.intent` (#14080) starts the app with an explicit intent
instead of its launcher intent, for example to open a debug screen with extras the
app reads. Fields: `component` (".DebugActivity", a fully qualified class, or
"`<appId>/<class>`"; a component in another package is refused), `action`, `data`
(URI), `mimeType`, `categories`, typed `extras` (`{ key, type, value }` with type
`string`, `int`, `long`, `float`, `boolean`, `stringArray` or `uri`), and `flags`
(`clearTask`, `newTask`, `singleTop`, `clearTop`, `noHistory`). Without a
`component`, the intent is pinned to the app with `-p`, so it needs an `action` or
`data` to resolve. Every value is shell-quoted on its own; there is no raw-command
field. An intent always launches, even when the app is already in front, and has no
monkey or launcher fallback: an `am start` refusal is a typed error whose message
starts with `[activity_not_exported]`, `[activity_not_found]`, `[intent_unresolved]`,
`[am_start_failed]`, or `[invalid_intent]` for a request refused before `am start`
runs. iOS refuses `intent`; use `launchArguments` there.

`installApp.artifactPath` is the host path to an `.app` or `.ipa` on iOS. On Android it is one
of:

- an `.apk` (`adb install`); add `splits` (a list of split `.apk` paths) to install it as the
  base APK with those splits through `adb install-multiple`.
- a directory of split APKs, for example a base plus per-ABI and per-density splits. Every `.apk`
  directly inside it is installed with `adb install-multiple`. `base.apk` or `base-master.apk`
  is the base the package name is read from; without either, the first file by name is used.
- an `.apks` APK set, installed with `bundletool install-apks`.
- an `.aab` app bundle. `bundletool build-apks --connected-device` builds an APK set for the
  target device in a private temp directory, then `bundletool install-apks` installs it. The
  temp directory is removed afterwards.

`bundle` holds the bundletool options. `bundle.modules` lists the dynamic feature modules to
install (`["_ALL_"]` for every module; by default only install-time modules), for `.aab` and
`.apks`. `bundle.localTesting` (`.aab` only) builds with `--local-testing`, so `install-apks`
also pushes the on-demand module splits where Play Core's local testing reads them.
`bundle.keystore` (`.aab` only) is `{path, alias, storePassword, keyPassword?}`; without it
bundletool signs with the debug keystore (`~/.android/debug.keystore`), and `keyPassword`
defaults to `storePassword`. The passwords are written to owner-only (0600) files in the private
temp directory and handed to bundletool as `--ks-pass=file:` and `--key-pass=file:`, never as
`pass:` arguments. They therefore never appear in process listings or in command-failure
messages. They are replaced with `<redacted>` in request logs, telemetry, plan logs, recorded
plans and bundletool error text. A password must be a single line.

`grantAllPermissions` grants every requested runtime permission (`install -g`;
`--grant-runtime-permissions` on the bundletool routes). `allowDowngrade` installs a lower
`versionCode` over the installed one (`install -d`; `--allow-downgrade` on the bundletool
routes); Android honors it only for debuggable apps, so a release-build downgrade still goes
through the downgrade recovery described below. The result carries `installRoute`
(`split-apks`, `apk-set` or `bundle`) for every route except a single APK.

The bundletool routes need bundletool on the host. AutoMobile uses the jar named by
`AUTOMOBILE_BUNDLETOOL_JAR` (run with `JAVA_HOME/bin/java`, else `java` on `PATH`), else a
`bundletool` on `PATH` (for example `brew install bundletool`). It never downloads bundletool.
The `bundletool` entry of the `automobile:host/toolchain` resource reports whether one was
found. When none is found, `installApp` fails before touching the device with a
`BundletoolNotFoundError` that lists these install steps. bundletool installs for every user,
since it takes no `--user`, while the adb routes keep the resolved target user.

Every route keeps the signing guard, the downgrade recovery and the installed-apps cache
invalidation of the single-APK install. The package name the signing guard checks comes from the
base APK, which is the base split for split installs and the base split extracted from the APK
set for `.apks` and `.aab`. An APK set without a base split cannot name its package, so a guarded
install of it refuses (`presence-unknown`). `splits`, `bundle`, `grantAllPermissions` and
`allowDowngrade` are rejected on iOS.
`uninstallApp.keepData` retains app data after uninstall on Android (default
false; Android only).

Opt-in signing guards (Android only; iOS rejects them). `installApp` and `uninstallApp` accept
`expectedSigningSha256`, the complete signer set (SHA-256 of every signing certificate,
64 hex characters, colons optional, see `inspectPackageSigning`). Before anything destructive
the tool reads the installed package fresh for the user it will mutate and refuses with a
`SigningGuardError` carrying `reason` (`mismatch`, `absent`, `presence-unknown`,
`signing-unavailable`) when the signer set differs, the lookup is inconclusive, or the signers
cannot be read; the device is unchanged in every case. Matching is exact set equality on the
current signers: one signer of a multi-signer package never satisfies a larger expected set, and
a rotated package matches its current signer, not its history. For `installApp` the guard applies
to a copy being replaced (checked on the target user, or on another user holding the shared
package); a package that is not installed passes with `signingGuard.status`
`no-existing-package`. For `uninstallApp` an absent package refuses (`absent`). A guarded
`uninstallApp` confirms removal with a fresh presence read: `removalVerification` is `absent` on
success, and `installed` or `unknown` (lookup failed) make `success` false. `installApp`
`allowDestructiveRecovery: false` fails an `INSTALL_FAILED_VERSION_DOWNGRADE` instead of
uninstalling and reinstalling (default true). AutoMobile serializes its own Android installs and
uninstalls per device, so a guarded check-then-mutate cannot interleave with another AutoMobile
mutation; package changes made outside AutoMobile (adb in a terminal, another tool) are not
visible to that lock, so hold the device exclusively when that matters.

`inspectPackageSigning` on Android takes `appId` and an optional `userId`; when omitted the
user is resolved the way `uninstallApp` does and reported as `userId` and `userSource`. Each
call reads the device (`dumpsys package`, `pm path`, and the installed base APK's signing
block); nothing is cached, and `observation` records `fresh: true`, `observedAt`, the scope,
and the device `apiLevel`. `presence` is `installed`, `absent`, or `unknown`: `absent` requires
PackageManager to report no such package or `installed=false` for that user, and a failed,
timed-out, malformed or cancelled lookup is `unknown`, never `absent`. `signing` is either
`{status: "available", scheme, signerSha256, signers, history?}` or
`{status: "unavailable", reason}`. `signerSha256` is the complete sorted signer set (a
multi-signer package lists every signer; all of them form the identity). Signers are chosen as
PackageManager would for the device API level: v3.1, then v3, then v2. For a rotated package
`history` is the certificate lineage, oldest first with the current signer last, copied from the
installed APK without re-verifying its signatures. JAR (v1)-only APKs, ZIP64 APKs, and a v3.1
package on a device whose API level cannot be read report `unavailable`. The signing read pulls
the installed base APK to a host temp file and removes it afterwards. It does not use CtrlProxy,
so helper version does not affect the result.

On iOS (#14099) the result has `platform: "ios"` and `deviceKind` (`simulator` or `physical`);
the Android fields above are unchanged, and `userId` is refused. The Simulator bundle is read in
place (`simctl get_app_container <udid> <bundle> app`); a physical device's bundle is copied off
with `devicectl device copy from` and the copy is removed afterwards. Both need macOS. A missing
app is `absent`; a failed lookup is `unknown`. `signing` is one of:

- `{status: "available", cdHash, identifier, teamId, signingIdentity, adHoc, authorities,
  entitlements, provisioningProfile, warnings?}`, from `codesign -dvvv`, the signed entitlements,
  and `security cms -D` on `embedded.mobileprovision`. iOS has no SHA-256 signer set, so the
  identity is the CodeDirectory hash (`cdHash`) plus `teamId` and the certificate chain
  (`authorities`, leaf first). `teamId` and `signingIdentity` are null for ad-hoc (Simulator)
  signatures.
- `{status: "unsigned", reason}` when codesign reports no signature.
- `{status: "unavailable", reason}` when codesign itself fails.

`provisioningProfile` is null when the bundle embeds none (Simulator and App Store builds);
otherwise it reports `name`, `uuid`, `teamIds`, `expirationDate`, `expired` (against host time)
and `provisionedDeviceCount`. A failed entitlement or profile read leaves that field null and
adds a `warnings` entry instead of failing the call.

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
process. Physical iOS 17+ devices (#14096) resolve the app's main-process PID with
<code>devicectl device info processes</code>, matched by the exact bundle ID's
installed path, then send SIGABRT with <code>devicectl device process signal</code>
(<code>mechanism: "ios_device_sigabrt"</code>). Neither path falls back to normal
termination.

Every result reports <code>success</code>, <code>supported</code>,
<code>platform</code>, <code>appId</code>, <code>mechanism</code>,
<code>timestamp</code>, and <code>confirmed</code>. It reports
<code>wasRunning</code> whenever preflight established process state;
confirmed crashes also report <code>processId</code> when available and include
immediate OS diagnostic evidence. <code>success: true</code> and
<code>confirmed: true</code> require fresh, target-specific crash evidence, not
merely command dispatch or process disappearance. Physical iOS is the one
exception, because device crash reports cannot be read yet (#14103): there
<code>success: true</code> means SIGABRT was delivered and the PID exited,
<code>confirmed</code> stays <code>false</code>, and <code>evidence.source</code> is
<code>"none"</code>.

After dispatch, <code>crashApp</code> also looks for the OS crash report for the
crashed process and returns it as <code>crashReport</code>. On iOS Simulator
that is the host's <code>~/Library/Logs/DiagnosticReports/*.ips</code>; on
Android it is the <code>dumpsys dropbox</code> <code>data_app_crash</code> or
<code>data_app_native_crash</code> entry. A report is attributed only when it
names the same Simulator UDID (iOS), app, and process ID, and was captured after
the crash was induced. A found report is bounded: exception type and codes,
termination reason, app version, report path, and the crashing thread's top
frames. It is also recorded as a <code>crash</code> entry in
<code>automobile:failures</code>, and its <code>failureOccurrenceId</code> is
returned. A matching report confirms a crash that the log heuristic missed (its
<code>evidence.source</code> is <code>ios_crash_report</code> or
<code>android_dropbox</code>). Otherwise <code>crashReport</code> is
<code>{"status": "notFound"}</code>. Physical iOS reports
<code>{"status": "unsupported", "reason": …}</code> until device retrieval is
verified.

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

### Android App Links verification

On Android 12 (API 31) and newer, an https link opens an app directly only when
the app is approved for the link's domain. Debug builds and CI emulators usually
fail verification (no network path to `assetlinks.json`, debug signing keys), so
`openLink` lands in the browser instead.

`getDeepLinks` reports this state for Android apps as `appLinks`, read with
`pm get-app-links --user <id> <appId>` for the current user (`appLinksUserId`).
Each entry has `domain`, `state` (`none`, `verified`, `approved`, `denied`,
`migrated`, `restored`, `legacy_failure`, `system_configured`, `pre_verified`, or
a numeric verifier error code), `autoVerify`, `userSelected`, and
`approvedForLinks`: whether the app may open the domain without a chooser (a
verified-equivalent state or a user selection, with link handling allowed).
`state` is absent for a domain declared without `android:autoVerify`.
`appLinkHandlingAllowed: false` means the user turned off "Open supported links".
On a pre-Android 12 device, or when the state cannot be read, `appLinks` is
omitted and `appLinksUnavailable` gives the reason; the rest of the result is
unchanged.

`setAppLinks` changes that state for `appId`. `action` selects the change:

| `action`        | Command                                                         | Arguments                                  |
| --------------- | --------------------------------------------------------------- | ------------------------------------------ |
| `approve`       | `pm set-app-links --package <appId> 2 <domains or all>`         | `domains` (optional, autoVerify domains)   |
| `reset`         | `pm set-app-links --package <appId> 0 <domains or all>`         | `domains` (optional, autoVerify domains)   |
| `reverify`      | `pm verify-app-links --re-verify <appId>`                       | none; the verifier answers asynchronously  |
| `userSelection` | `pm set-app-links-user-selection --user <id> --package <appId>` | `enabled` (required), `domains` (optional) |
| `restore`       | writes back the recorded original state                         | none                                       |

`userId` selects the Android user for `userSelection` and for the read-back; it
defaults to the current user. Verification states are per package, not per user.
`domains` omitted means every declared domain. A domain the app does not declare
is refused before any write; `approve` and `reset` accept only autoVerify domains
(use `userSelection` for the others). `pm` reports no per-domain failure, so the
result reads the state back: `changed` lists each domain whose state or selection
changed (`before`/`after`), `unapplied` lists requested domains that did not take,
and `appLinks` is the state after the call.

The state before the first `setAppLinks` change is recorded once per device and
package, and returned as `restore`: `verification` lists each domain's `original`
state and the state it is restored as (`restoreAs`), and `userSelections` lists
each changed user's originally enabled domains. Within a daemon session
(`sessionUuid`), release or rebind writes it back before the device is handed on;
otherwise `action: "restore"` does. The shell can set only `none`, `verified`,
`approved` and `denied`, so a restore is not always exact (`exact: false`):
`migrated`, `restored`, `system_configured` and `pre_verified` come back as
`verified`, which opens links the same way but lets the verifier overwrite it, and
`legacy_failure` or a numeric error code comes back as `none`. A `reverify` still
in flight can overwrite a restored `none` or `verified` state. The record lives in
daemon memory: a daemon restart loses it, and the device keeps the last state.
iOS universal links are not covered; `setAppLinks` refuses iOS devices.

## Devices & system state

Devicectl-only simulator features such as orientation, per-display screenshots, and Duo hinge/active-panel support are Planned (#8349, #8350, #8351) and will require CoreDevice >= 651. No current tool is gated on CoreDevice version. The lazy production probe checks boot state before devicectl and memoizes captured unsupported feature IDs; doctor and `automobile:host/toolchain` retain the bounded `devicectl --version` read and seed the injected probe, alongside simulator boot counts and observed capabilities. Capability state stays "not probed" until a real command runs; the downgrade guard is out of scope per the owner decision on 2026-10-02 and is not reported. The CoreDevice doctor result includes the summary in its optional `detail` string, which the console prints on an indented line below the version for every check status. JSON retains the existing fields and adds `detail`. See the [iOS simctl and devicectl boundary design](design-docs/plat/ios/simctl-devicectl-boundary.md).

| Tool                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📋 <code>listDevices</code>                                                    | Lists booted devices using the shared device description: identity, runtime, form factor, lifecycle, and session summary; a note points to MCP resources for image detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🖼️ <code>listDeviceImages</code>                                               | Lists configured images using the same canonical identity, runtime, display, lifecycle, provenance, and capability inventory shape as the images resource.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🤖 <code>getAndroid</code> / 🍎 <code>getApple</code>                          | Finds or recovers an Android AVD or iOS Simulator for automation; Android identity includes API level and OS version when known.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🧱 <code>provisionDevice</code>                                                | Provisions an exact virtual-device identity, with optional resource configuration before automation readiness and an optional Android manufacturer profile (`spec.deviceProfile`) after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ⚙️ <code>setDeviceResources</code>                                             | Configures selected device resources and returns verified, unsupported, or unknown state; omitted settings stay unchanged. Omitted from discovery by default: select it with `setToolEnabled` (case-sensitive `setDeviceResources`) or `--enable-tool setDeviceResources`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 🧭 <code>reconcileDeviceResources</code>                                       | Compares an iOS Simulator with a requested resource map (workload profile) and reports typed drift: `missingRequested`, `ownedExtra`, `unsupported`, `commandFailure`. Report-only by default; `repair: true` applies only the drifted delta, re-reads, and fails closed. Omitted from discovery by default: select it with `setToolEnabled` (case-sensitive `reconcileDeviceResources`) or `--enable-tool reconcileDeviceResources`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔧 <code>setActiveDevice</code>                                                | Sets the active device. Optional session `display` pins a panel key/role; `null` clears, omission preserves. Explicit display beats pin, then focus/posture. Pins clear on release/rebind; direct mode unsupported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ❌ <code>killDevice</code> / 🧹 <code>deleteDevice</code>                      | Stops a device, or stops and permanently deletes it. Both accept `force: true`, which drops every AVD-name comparison for a wedged Android emulator — the emulator-console confirmation and the platform kill's own re-discovery check — and acts on whatever occupies the serial; it does not bypass serial selection, nor the refusals raised when the pooled entry was retired and replaced mid-action, or when no booted target can be identified at all. Both also refuse a device another session holds (`device_owned_by_other_session`) unless the caller is the holder; `force: true` overrides that refusal on any platform. See [Device ownership](using/device-ownership.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📸 <code>deviceSnapshot</code>                                                 | Captures or restores a device snapshot. Android VM restores in daemon mode return the new deviceSessionUuid and supersede the previous device-session epoch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔄 <code>rotate</code>                                                         | Changes device orientation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 📖 <code>setPosture</code>                                                     | Sets a supported posture or a BEST EFFORT hingeAngle (0-180 degrees, emulator/simulator only). Exactly one selector is required; angle requests cannot use displayPreset. Unsupported angles return status: "unsupported" with a reason and no state change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 📶 <code>statusBar</code>                                                      | Overrides, clears, or reads the status bar (time, battery, signal, data network, carrier) for deterministic screenshots and video: iOS Simulator `simctl status_bar`, Android SystemUI demo mode. Physical iOS returns status: "unsupported". A session's override is cleared when it releases the device.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🪟 <code>windowMode</code>                                                     | Android: puts an app's task into fullscreen, picture-in-picture, freeform (with bounds) or split screen with a second app and reads the mode and bounds back; returns a restore receipt. Omitted from discovery by default: select it with `setToolEnabled` or `--enable-tool windowMode`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🌐 <code>openLink</code>                                                       | Opens web URLs or routes app and universal deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🧰 <code>homeScreen</code> / <code>recentApps</code> / <code>systemTray</code> | Controls core system surfaces and notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🔓 <code>wakeAndUnlock</code>                                                  | Wakes and unlocks the keyguard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🌍 <code>changeLocalization</code>                                             | Changes locale, time zone, text direction, time format, and calendar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ⚙️ <code>getDeviceState</code> / ⚙️ <code>setDeviceState</code>                | Reads or changes Do Not Disturb, simulator biometric enrollment, network condition, and static geolocation. Set a point with `location: { mode: "static", latitude: 37.7749, longitude: -122.4194 }` on an Android emulator or iOS Simulator. Latitude must be within −90..90 and longitude within −180..180. The result echoes the applied coordinate; location read-back is unavailable, and physical devices return an unsupported error. On release or rebind of a session that set a location, iOS Simulator clears it with `simctl location clear`; failed clears are retried and quarantine the device until success or removal. Android emulator fixes persist after the session because the emulator console has no unset command; reset the fix explicitly if needed. Direct-mode (sessionless) calls are unchanged. A sessionless fix written while a session marker remains on that device is cleared by that session's release; markers are per device and session, not per write. `getDeviceState` also reads back the Android connectivity toggles — `airplaneMode`, `wifiEnabled`, `bluetoothEnabled`, `locationEnabled` — in a single adb round-trip, so a toggle can be checked before it is flipped; a bare call returns `doNotDisturb` + `connectivity`, and `include` selects any subset. A connectivity field is `true`/`false`, or omitted when the device could not answer it (key absent on this API level, or an unparsable value) — omitted never means off. Connectivity is unsupported on iOS: Airplane mode, Wi-Fi, Bluetooth and Location have no simctl/devicectl read verb, and a simulator shares the host's network stack. Degraded profiles — including `offline` — are best-effort cellular shaping on an Android emulator (`adb emu network …`/`gsm data off` plus a best-effort Wi-Fi disable), reported `partial`: they may not affect Wi-Fi or app traffic. Only reset to `none` is fully verified. A session restores the network to a clean `none` state on release. Network shaping is unsupported on physical Android and all iOS.                                                           |
| 🔠 <code>displayConfig</code>                                                  | Reads or sets font/text scale, effective display density, and light/dark theme for adaptive-layout and large-font accessibility testing. Android supports all three fields (density overrides are best-effort on physical devices); iOS supports theme (the Simulator via `simctl ui appearance`, physical devices through the CtrlProxy runner (`XCUIDevice.appearance`)) and, on the Simulator only, font scale as a Dynamic Type category via `simctl ui content_size` (`fontScale` picks the nearest category, `contentSize` picks one exactly). Also reads and sets the increaseContrast, reduceMotion and boldText accessibility preferences on Android and the iOS Simulator, with per-field `supported`. Android reset restores font scale and density to device defaults and restores night mode only to the value displayConfig replaced earlier in this process; otherwise night mode is left unchanged. Android reset never forces light. Omitted from discovery by default — select it with `setToolEnabled` (case-sensitive `displayConfig`) or `--enable-tool displayConfig`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 📐 <code>displayProfile</code>                                                 | Android: applies or resets an OEM-style display persona (size, density, font scale, cutout and nav-mode overlays, force dark, posture) in one call; opt-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 🧬 <code>getIosSimulatorCapabilities</code>                                    | Discovers biometrics for a selected iOS Simulator device type and runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🫆 <code>biometricAuth</code>                                                  | Simulates biometric authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 📳 <code>shake</code>                                                          | Shakes an Android emulator or iOS Simulator; duration must be an integer from 1 to 1,798,000 ms, and Android intensity must be from 1 to 1,000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🎚️ <code>setSensor</code>                                                      | Sets or resets one Android emulator virtual sensor (`acceleration`, `gyroscope`, `magnetic-field`, `orientation`, `temperature`, `proximity`, `light`, `pressure`, `humidity`) through the emulator console, returning `applied`, `previous` and a `restore` receipt. Pass `sensor` plus exactly one of `value` or `reset: true`. A daemon session (`sessionUuid`) restores every sensor it changed on release or rebind. Physical devices and iOS are refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 📞 <code>phoneCall</code> / 💬 <code>sendSms</code>                            | Simulates an incoming call or SMS: Android emulator console, or CallKit and a notification through the app's AutoMobile iOS SDK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🎵 <code>mediaSession</code>                                                   | Android: reads media sessions (playback state, position, speed, metadata, actions), dispatches a transport key to the media button session like a headset, or sets a music/ring/alarm stream volume; mutations return a restore receipt. Omitted from discovery by default: select it with `setToolEnabled` or `--enable-tool mediaSession`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔔 <code>postNotification</code>                                               | Posts a notification through Android SDK hooks or iOS Simulator push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 🔔 <code>getNotificationPolicy</code> / 🔔 <code>setNotificationPolicy</code>  | Reads or changes app notification and Do Not Disturb policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🛂 <code>getAppPermissions</code> / 🛂 <code>setAppPermissions</code>          | Reads or changes app permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 🪫 <code>killProfile</code>                                                    | Android: applies or resets an OEM background-kill profile (standby bucket, appops, Doze, force-stop) on a stock device; opt-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🎭 <code>manufacturerProfile</code>                                            | Android: applies, resets or describes an OEM manufacturer profile (keyboard profile, kill profile and display profile, with per-facet evidence status) on a stock device; opt-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 🚨 <code>systemAlerts</code>                                                   | Sets how OS permission and system alerts are handled around each UI interaction: report (default), allow, deny or allowOnce, with label-based match entries; opt-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tool                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📋 <code>listDevices</code>                                                    | Lists booted devices using the shared device description: identity, runtime, form factor, lifecycle, and session summary; a note points to MCP resources for image detail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🖼️ <code>listDeviceImages</code>                                               | Lists configured images using the same canonical identity, runtime, display, lifecycle, provenance, and capability inventory shape as the images resource.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🤖 <code>getAndroid</code> / 🍎 <code>getApple</code>                          | Finds or recovers an Android AVD or iOS Simulator for automation; Android identity includes API level and OS version when known.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🧱 <code>provisionDevice</code>                                                | Provisions an exact virtual-device identity, with optional resource configuration before automation readiness and an optional Android manufacturer profile (`spec.deviceProfile`) after it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ⚙️ <code>setDeviceResources</code>                                             | Configures selected device resources and returns verified, unsupported, or unknown state; omitted settings stay unchanged. Omitted from discovery by default: select it with `setToolEnabled` (case-sensitive `setDeviceResources`) or `--enable-tool setDeviceResources`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 🧭 <code>reconcileDeviceResources</code>                                       | Compares an iOS Simulator with a requested resource map (workload profile) and reports typed drift: `missingRequested`, `ownedExtra`, `unsupported`, `commandFailure`. Report-only by default; `repair: true` applies only the drifted delta, re-reads, and fails closed. Omitted from discovery by default: select it with `setToolEnabled` (case-sensitive `reconcileDeviceResources`) or `--enable-tool reconcileDeviceResources`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔧 <code>setActiveDevice</code>                                                | Sets the active device. Optional session `display` pins a panel key/role; `null` clears, omission preserves. Explicit display beats pin, then focus/posture. Pins clear on release/rebind; direct mode unsupported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ❌ <code>killDevice</code> / 🧹 <code>deleteDevice</code>                      | Stops a device, or stops and permanently deletes it. Both accept `force: true`, which drops every AVD-name comparison for a wedged Android emulator — the emulator-console confirmation and the platform kill's own re-discovery check — and acts on whatever occupies the serial; it does not bypass serial selection, nor the refusals raised when the pooled entry was retired and replaced mid-action, or when no booted target can be identified at all. Both also refuse a device another session holds (`device_owned_by_other_session`) unless the caller is the holder; `force: true` overrides that refusal on any platform. See [Device ownership](using/device-ownership.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 📸 <code>deviceSnapshot</code>                                                 | Captures or restores a device snapshot. Android VM restores in daemon mode return the new deviceSessionUuid and supersede the previous device-session epoch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🔄 <code>rotate</code>                                                         | Changes device orientation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 📖 <code>setPosture</code>                                                     | Sets a supported posture or a BEST EFFORT hingeAngle (0-180 degrees, emulator/simulator only). Exactly one selector is required; angle requests cannot use displayPreset. Unsupported angles return status: "unsupported" with a reason and no state change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🌐 <code>openLink</code>                                                       | Opens web URLs or routes app and universal deep links.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🧰 <code>homeScreen</code> / <code>recentApps</code> / <code>systemTray</code> | Controls core system surfaces and notifications.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🔓 <code>wakeAndUnlock</code>                                                  | Wakes and unlocks the keyguard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 🌍 <code>changeLocalization</code>                                             | Changes locale, time zone, text direction, time format, and calendar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ⚙️ <code>getDeviceState</code> / ⚙️ <code>setDeviceState</code>                | Reads or changes Do Not Disturb, simulator biometric enrollment, network condition, and static geolocation. Set a point with `location: { mode: "static", latitude: 37.7749, longitude: -122.4194 }` on an Android emulator, iOS Simulator, or physical iOS device. Latitude must be within −90..90 and longitude within −180..180. The result echoes the applied coordinate; location read-back is unavailable, and physical Android returns an unsupported error. On release or rebind of a session that set a location, iOS clears it (`simctl location clear` on a Simulator, the runner on a physical device); failed clears are retried and quarantine the device until success or removal. Android emulator fixes persist after the session because the emulator console has no unset command; reset the fix explicitly if needed. Direct-mode (sessionless) calls are unchanged. A sessionless fix written while a session marker remains on that device is cleared by that session's release; markers are per device and session, not per write. `getDeviceState` also reads back the Android connectivity toggles — `airplaneMode`, `wifiEnabled`, `bluetoothEnabled`, `locationEnabled` — in a single adb round-trip, so a toggle can be checked before it is flipped; a bare call returns `doNotDisturb` + `connectivity`, and `include` selects any subset. A connectivity field is `true`/`false`, or omitted when the device could not answer it (key absent on this API level, or an unparsable value) — omitted never means off. Connectivity is unsupported on iOS: Airplane mode, Wi-Fi, Bluetooth and Location have no simctl/devicectl read verb, and a simulator shares the host's network stack. Degraded profiles — including `offline` — are best-effort cellular shaping on an Android emulator (`adb emu network …`/`gsm data off` plus a best-effort Wi-Fi disable), reported `partial`: they may not affect Wi-Fi or app traffic. Only reset to `none` is fully verified. A session restores the network to a clean `none` state on release. Network shaping is unsupported on physical Android and all iOS. |
| 🔠 <code>displayConfig</code>                                                  | Reads or sets font/text scale, effective display density, and light/dark theme for adaptive-layout and large-font accessibility testing. Android supports all three fields (density overrides are best-effort on physical devices); the iOS Simulator supports theme only, via `simctl ui appearance`; physical iOS is unsupported. Android reset restores font scale and density to device defaults and restores night mode only to the value displayConfig replaced earlier in this process; otherwise night mode is left unchanged. Android reset never forces light. Omitted from discovery by default — select it with `setToolEnabled` (case-sensitive `displayConfig`) or `--enable-tool displayConfig`; direct calls by name remain available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 🧬 <code>getIosSimulatorCapabilities</code>                                    | Discovers biometrics for a selected iOS Simulator device type and runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 🫆 <code>biometricAuth</code>                                                  | Simulates biometric authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 📳 <code>shake</code>                                                          | Shakes an Android emulator or iOS Simulator; duration must be an integer from 1 to 1,798,000 ms, and Android intensity must be from 1 to 1,000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 📞 <code>phoneCall</code> / 💬 <code>sendSms</code>                            | Simulates an incoming call or SMS: Android emulator console, or CallKit and a notification through the app's AutoMobile iOS SDK.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 🔔 <code>postNotification</code>                                               | Posts a notification through Android SDK hooks or iOS Simulator push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 🔔 <code>getNotificationPolicy</code> / 🔔 <code>setNotificationPolicy</code>  | Reads or changes app notification and Do Not Disturb policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 🛂 <code>getAppPermissions</code> / 🛂 <code>setAppPermissions</code>          | Reads or changes app permissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Clock control uses `setDeviceState` with `clock: { mode: "set", instant: "2026-10-01T00:00:00Z" }`, `clock: { mode: "advance", byMs: 60000 }`, or `clock: { mode: "reset" }`. Set requires ISO-8601 with Z or an explicit offset within **2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z, inclusive** (`MIN_DEVICE_CLOCK_INSTANT_MS` / `MAX_DEVICE_CLOCK_INSTANT_MS`). Advance requires an integer `byMs >= 1000`, at most `MAX_DEVICE_CLOCK_ADVANCE_MS` (315360000000, ten 365-day years). An early device read rejects cumulative targets outside that window before any clock or other field mutation. Immediately before the clock write, after other requested fields, root acquisition and disabling automatic time, advance reads the device again and range-checks the fresh target. A target that leaves the window during those operations returns a typed clock-field failure; other fields retain their results. Read-only root-capability probes and `date +%s` may run during validation. All inputs are validated before applying any field. Only rootable Android emulators support writes; Play Store images, physical Android devices, and all iOS targets return unsupported. Changing the clock affects TLS/certificate validation, token expiry, and the daemon's own freshness checks for that device.

Set/advance disable automatic time. Results report `instant`, `automaticTime`, `requestedInstant`, `appliedInstant`, `readBack`, `verified`, and `toleranceMs` (2000). Commands have **second-level precision**, truncating milliseconds. Advance verifies at least the requested whole seconds minus tolerance, with a minimum one-second movement; a no-op is never verified. Set within tolerance of current device time reports distinct `outcome: "unchanged"`, without writing clock state. Every clock change (set/advance/reset and lifecycle restore, including potentially partially applied failures) invalidates hierarchy/observe caches and freshness baselines so backward jumps cannot reuse stale hierarchies.

At the first mutation, a session records original `auto_time`, ownership of the clock change, and whether AutoMobile rooted adbd. On **session release/rebind/device teardown/reset**, AutoMobile explicitly steps the clock to **HOST-derived real time** (injected host Timer), restores original `auto_time`, and verifies both by read-back, including when original `auto_time=1` because emulators may never automatically re-sync. A failed restore retains pending ownership and retries; the device stays quarantined until restoration succeeds or the device is removed. Each command and the initial teardown wait are bounded; retries use the existing network restore delay (250ms) and pending-device-cleanup pool quarantine, continuing past its bounded retry batch. Reset clears the slot only after verification.

Clock control can **restart adbd on the emulator**; connections such as port forwards may be re-established. It probes `shell id` before rooting and unroots on restore only if AutoMobile rooted it, using bounded `unroot` / `wait-for-device` commands. Unroot failure is logged and best-effort, and does not fail verified clock/auto-time restoration. The existing legacy locale root path likewise waits for ADB and verifies root, with no explicit port-forward/CtrlProxy reconnect step.

The restore slot is **in memory only**: daemon restart loses it, potentially leaving a wrong clock and `auto_time=0`. `reset` is the recovery: with no recorded slot on a rootable emulator, it writes HOST time and `auto_time=1`. Reset checks target support and recorded ownership before root capability. Physical Android and iOS get no root/clock commands; without a slot, a root-refusing Play Store image reports unsupported/"nothing to reset" with no clock mutations. With a slot, refused root reports a typed failure and keeps restoration pending. Session-bound and sessionless clock mutations serialize through one device queue and inherit one original `auto_time` and root-ownership baseline, in either calling order. Session release still restores host time and original `auto_time`; a sessionless claim retains the original baseline until explicit reset or device removal. Removal aborts queued and in-flight clock commands for that device incarnation. Direct/sessionless mode retains original `auto_time` and root ownership per device until explicit reset or device removal; it has no automatic lifecycle restore, so callers must reset explicitly. Operational clock failures are typed per-field failures (`verified:false`) and do not lose other fields' results or prevent a successfully applied network condition's TTL from being armed.

`getDeviceState` with `include: ["clock"]` reads current Android instant and automatic time without root, including physical devices and non-rootable images; iOS reports unsupported. The default read selection remains Do Not Disturb and connectivity.

`getDeviceState` with `include: ["sensors"]` reads every `setSensor` sensor on an Android emulator with `adb emu sensor get <name>`, one console round trip per sensor. `sensors.sensors` lists `{ name, value }` for each readable sensor; `sensors.unavailable` lists `{ name, reason }` for sensors the console refuses (for example a sensor the AVD disables) or answers unrecognizably. Physical Android devices and iOS report `sensors` unsupported without failing the read.

Camera posters use `setDeviceState` with `cameraPoster: { mode: "image", path: "/abs/poster.png" }`, `cameraPoster: { mode: "qr", text: "payload" }`, or `cameraPoster: { mode: "clear" }`, plus an optional `surface` of `wall` (default) or `table`. It runs `adb -s <serial> emu virtualscene-image <surface> [path]` on a **running** Android emulator, with no gRPC client and no cold restart; QR payloads reuse the `startDevice` `cameraPosterQr` poster writer. The path must be a PNG/JPG/JPEG that exists and contains no whitespace (the console splits on spaces). The AVD back camera must be `virtualscene`: boot it with `startDevice` `cameraPosterPath` or `cameraPosterQr`, otherwise the console refuses and the error is returned with that hint. iOS and physical Android return unsupported. The console answering `OK` does not confirm the camera shows the poster: the virtual scene's default camera pose may not face it, and nothing reads the camera frame back, so the result carries a `warning` instead of `verified`. The poster persists until cleared or the AVD is cold-booted.

Location route playback uses `setDeviceState` with `location: { mode: "route", waypoints: [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }], durationMs: 10000 }`. Provide exactly one of positive, finite `durationMs` or `speedMetersPerSecond`. A route needs at least two ordered waypoints; latitude is −90..90, longitude is −180..180, and optional altitude is finite. `loop` defaults to false; `updateIntervalMs` defaults to 1000 and accepts integers from 200 to 60000. Starting a route returns immediately with its waypoint count, total distance, expected duration, loop, interval, and method. iOS Simulator interpolates on the host and sends repeated `simctl location set` commands; a physical iOS device gets the same host-timed fixes through the CtrlProxy runner's `request_location`. Three consecutive fix failures stop playback and are logged; the next location write reports the failed route in `previousRoute` with `endedReason: "failed"` and `lastError`.

One route runs per device. A static fix, new route, `location: { mode: "stop" }`, session release, unbind, or device removal cancels it. On release or rebind of a session that set a location, iOS Simulator clears it with `simctl location clear`; failed clears are retried and quarantine the device until success or removal. Android emulator fixes persist after the session because the emulator console has no unset command; reset the fix explicitly if needed. Direct-mode (sessionless) calls are unchanged. A sessionless fix written while a session marker remains on that device is cleared by that session's release; markers are per device and session, not per write. Stop reports `stopped: false` when idle and `previousRoute` when a route ended, including its `endedReason` (`completed`, `failed`, `replaced`, or `stopped`) and any `lastError`.

Device-condition fixtures use `setDeviceState` with `deviceCondition: { ... }`, behind the `device-condition` feature flag (off by default). It is the session-scoped surface for the root/integrity/fault test fixtures of epic #14047: a versioned object with `rootState`, `integrityState`, a `faults` map, an optional `expiresInSeconds` lease, and `reset`. Each applied condition registers a reset that runs — newest first, verified against a clean read-back — on session release, rebind, or lease expiry, so a device never returns to the pool holding a fixture; the `expiresInSeconds` lease needs a session to enforce it. The `rootState`/`integrityState` fields accept only `"unset"` until their injectors land, and `deviceCondition` must be sent in its own call rather than combined with the other `setDeviceState` fields. The `faults` sub-object carries the power-domain fault injectors (Android only, root-free): `battery` (`unplug` / `low` / `full` via `dumpsys battery`, reset with `dumpsys battery reset`), `lowPower` (`settings global low_power`, restored to its prior value), `doze` (`dumpsys deviceidle force-idle`, reset with `unforce`), and `thermal` (`cmd thermalservice override-status`, reset with `reset`). Each fault clears with `"unset"`. The version-sensitive verbs (`deviceidle`, `thermalservice`) probe their capability first and return an "unsupported on this image" result instead of half-applying.
Lock-screen credentials use `setDeviceState` with `screenLock: { type: "pin", credential: "1357" }`, `screenLock: { type: "password", credential: "s3cret" }`, `screenLock: { type: "pattern", credential: "14789" }` (cells of the 3x3 grid as digits 1-9, row by row, each used once), or `screenLock: { type: "none", currentCredential: "1357" }` to clear one. It runs `adb shell locksettings set-pin|set-password|set-pattern|clear` for user 0 on an Android emulator or physical device, so `KeyguardManager.isDeviceSecure()` becomes true and Keystore keys that need user authentication can be generated; iOS returns unsupported. A PIN is 4-16 digits; a password or `currentCredential` is 4-16 printable ASCII characters, not starting with `-` and without a single quote. `getDeviceState` with `include: ["screenLock"]` reads the credential type (`none`, `pin`, `password`, `pattern`, or `unknown`) from `dumpsys lock_settings`, falling back to the keyguard's `secure` flag.

The result reports only the type and outcome, such as `screenLock: { type: "pin", set: true, outcome: "set", verified: true, restoreOnRelease: true }`; the credential is never returned. Within a session, AutoMobile keeps the credential in daemon memory (never on disk) so that session can replace it (`--old`) and its release or rebind clears it. A leaked lock blocks every later session on the device, so the outcome of that clear is returned in the session-release result as `screenLockRestore` (`cleared`, `failed` with the leftover and how to remove it, `skipped` for a replaced device, or `pending` if still running at the teardown cap); a refused credential is not retried, because each refusal counts toward the device's failed-attempt lockout. A daemon restart loses the in-memory credential, leaving the lock until it is cleared by hand. A sessionless set is never cleared automatically and carries a `warning`. An existing credential this session did not set is never overwritten: the call fails with `errorCode: "lock_credential_preexisting"` and no write; a wrong `currentCredential` fails with `lock_credential_mismatch`. Any change also drops the PIN `wakeAndUnlock` remembered for the device.

The credential is replaced by `<redacted>` in request and plan logs, telemetry, the memory-audit store and `recordToolCalls` plans (the recorder warns that a replay needs it set by hand). AutoMobile's adb logs and command errors show `shell locksettings <credential redacted>`, and `locksettings` output, which echoes credentials, is scrubbed before it can reach an error. The credential is still an argument of the `locksettings` process on the device while it runs, so it is visible to anything that can list device processes for that moment. Work-profile users are not supported yet.

On a physical iOS device (#14091), static fixes and route playback go through the
CtrlProxy runner's `request_location` command, which sets XCUITest's
`XCUIDevice.shared.location` (iOS 16.4+, Xcode 14.3+; the runner itself targets iOS 17),
and the result reports `method: "ios_ctrl_proxy"`. Session release and rebind clear it
with the same command (`clear: true`), which restores the device's real location, with
the Simulator's retry and quarantine rules. A runner that predates `request_location`
returns `supported: false` with an error naming the requirement.
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
`extras` are stripped from both by default; where supported, `includeExtras: true` retains them
only in structured content. Error detail remains in `content[0].text`.

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

### Background-kill profiles (`killProfile`)

`killProfile` (Android, opt-in with `setToolEnabled`) reproduces the **effect** of an OEM's
background restrictions on a stock emulator or device (#14051). It simulates what the app
observes, not the OEM firmware that causes it. `action: "list"` returns the catalog and the
behaviour that cannot be simulated; it changes nothing on the device.

| Profile                     | Steps                                                        | Evidence            |
| --------------------------- | ------------------------------------------------------------ | ------------------- |
| `samsung-sleeping`          | `dumpsys battery unplug`; `am set-standby-bucket restricted` | `vendor_documented` |
| `samsung-deep-sleeping`     | `am force-stop`; `appops RUN_ANY_IN_BACKGROUND ignore`       | `inferred`          |
| `xiaomi-autostart-off`      | `am force-stop`; `appops RUN_ANY_IN_BACKGROUND ignore`       | `inferred`          |
| `oneplus-deep-optimization` | `am force-stop`; `appops RUN_ANY_IN_BACKGROUND ignore`       | `inferred`          |
| `recents-swipe-kill`        | `KEYCODE_HOME`; `am kill` (soft)                             | `inferred`          |
| `recents-swipe-force-stop`  | `KEYCODE_HOME`; `am force-stop` (hard)                       | `inferred`          |
| `oneplus-sleep-standby`     | `dumpsys battery unplug`; `dumpsys deviceidle force-idle`    | `inferred`          |
| `motorola-adaptive`         | `am set-standby-bucket rare`                                 | `inferred`          |
| `user-restricted`           | `appops RUN_ANY_IN_BACKGROUND ignore`                        | `cdd_derived`       |
| `exact-alarm-denied`        | `appops --uid SCHEDULE_EXACT_ALARM deny`                     | `vendor_documented` |

```ts
killProfile({ action: "apply", appId: "com.example.app", profile: "user-restricted" });
killProfile({ action: "reset", appId: "com.example.app" });
```

- Each step reports `applied`, `unsupported` (for example the restricted bucket below API 30,
  RUN_ANY_IN_BACKGROUND below API 28, or force-idle with Doze disabled) or `failed`. The
  profile's `status` is `applied`, `partial` or `unsupported`. A profile that changes nothing
  because a step failed is an error.
- `apply` is idempotent. Before the first change it records the battery state, standby bucket
  and appop modes, and the result's `restore.commands` lists what reset will run. Applying
  again never overwrites that record. `am kill`, `am force-stop` and `KEYCODE_HOME` have
  nothing to restore.
- `reset` restores the recorded state for that app plus the device-wide battery and Doze
  state, then forgets it, so a second reset changes nothing. The record is in memory only:
  after a daemon restart, `reset` with `baseline: true` writes the AOSP defaults instead
  (`dumpsys battery reset`, `dumpsys deviceidle unforce`, bucket `active`, appops `default`).
- In a daemon session (`sessionUuid`), release or rebind restores every facet the session
  changed before the next session can acquire the device. Sessionless changes persist until
  `reset`. The shared `platform` and `keepScreenAwake` device options apply as for other tools.
- Not reproducible, and reported by `list` as `nonEmulatable`: OEM triggers such as "unused
  for 3 days", exemption resets after a firmware update, and Xiaomi's proprietary AppOps
  10008/10021.

### OEM display persona (`displayProfile`)

`displayProfile` (Android, opt-in with `setToolEnabled`) approximates an OEM's look and
geometry on a stock device in one call (#14052). It composes `displayConfig` and `setPosture`
rather than duplicating them. Runtime resource overlays cannot overlay code, so it cannot
reproduce OEM SystemUI such as One UI's.

```ts
displayProfile({
  action: "apply",
  density: 480, // approximates Samsung "Screen zoom"; same values as displayConfig
  fontScale: 1.15,
  screenSize: "1080x2340", // wm size; "default" resets it
  cutout: "hole", // none | corner | double | hole | tall | waterfall
  navigationMode: "gestural", // gestural | threebutton | twobutton
  forceDark: true, // Samsung/Xiaomi forced dark
  posture: "half_opened", // foldable AVDs and devices, as setPosture
});
displayProfile({ action: "reset" });
```

| Field            | Device change                                                                             | Notes                                         |
| ---------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------- |
| `screenSize`     | `wm size WxH` / `wm size reset`                                                           | `partial` on physical devices (OEM clamping)  |
| `density`        | `displayConfig` density                                                                   | `partial` on physical devices                 |
| `fontScale`      | `displayConfig` font scale                                                                |                                               |
| `cutout`         | `cmd overlay enable-exclusive --category com.android.internal.display.cutout.emulation.*` | API 29+; `unsupported` if the image lacks it  |
| `navigationMode` | `cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.*`          | API 29+                                       |
| `forceDark`      | `setprop debug.hwui.force_dark`, plus night mode when `true`                              | API 29+; relaunch the app to see it           |
| `posture`        | `setPosture`                                                                              | `unsupported` when the device is not foldable |

- Each step reports `applied`, `partial`, `unsupported` or `failed`, and the profile's
  `status` is `applied`, `partial` or `unsupported`. A failed step does not stop the others.
  A profile that changes nothing because a step failed is an error.
- The state before each facet's first change is recorded once: the size override, the display
  values `displayConfig` replaced, the enabled cutout and navigation overlays, the previous
  `debug.hwui.force_dark` value and the committed posture. Applying more profiles never
  overwrites that record. `restore.facets` lists what is waiting to be restored. A posture the
  device cannot report is set but not restorable, and that step is `partial`.
- `reset` restores every recorded facet, latest first, then forgets it, so a second reset
  changes nothing. A facet the device refuses stays recorded and the reset is an error.
- In a daemon session (`sessionUuid`), release or rebind restores every facet the session
  changed before the next session can acquire the device. Font scale, density and night mode
  are also recorded for the next-owner settings reset, as with `displayConfig`. Sessionless
  changes persist until `reset`. The record is in memory only. The shared `platform` and
  `keepScreenAwake` device options apply as for other tools.

### Manufacturer profiles (`manufacturerProfile`)

`manufacturerProfile` (Android, opt-in with `setToolEnabled`) bundles the keyboard profile,
`killProfile` and `displayProfile` into one named OEM manufacturer profile and applies it with
those executors (#14055). It simulates what an app observes on that OEM's devices, not the
firmware. See [Manufacturer profiles](using/oem-personas.md) for the catalog and its evidence.

```ts
manufacturerProfile({ action: "list" }); // catalog version, manufacturerProfiles, evidence statuses
manufacturerProfile({ action: "describe", manufacturerProfile: "samsung-oneui" }); // facets, evidence, nonEmulatable
manufacturerProfile({
  action: "apply",
  manufacturerProfile: "samsung-oneui",
  appId: "com.example.app",
});
manufacturerProfile({
  action: "apply",
  manufacturerProfile: "samsung-oneui",
  appId: "com.example.app",
  requires: ["samsung-dex"], // returns route_to_real_device and changes nothing
});
manufacturerProfile({ action: "reset" });
```

- `list` and `describe` change nothing on the device. `describe` reports every facet with its
  category (`functionalityBreak` or `oemFeature`), its value and its evidence: `status`
  (`focused_trace`, `vendor_documented`, `cdd_derived`, `inferred` or `experimental`), `note`
  and `source`.
- `apply` runs the keyboard, kill and display facets in that order. `appId` is required for
  a manufacturer profile with a kill profile. Each facet reports `applied`, `partial`,
  `unsupported` or `failed`; a failed facet does not stop the others, and a manufacturer profile
  that changes nothing is an error. The result names the profile's `version` (in
  `manufacturerProfile`) and the catalog's `catalogVersion`.
- Manufacturer profiles replace one another: applying one other than the one recorded on the
  device first resets the recorded one, and the result names it as `replaced`. Re-applying the
  same manufacturer profile (for example for another `appId`) does not reset it.
- `requires` lists OEM capabilities the task needs. When the manufacturer profile lists one of
  them as `nonEmulatable`, `apply` returns `success: false` and `status: "route_to_real_device"`
  with the capabilities and changes nothing.
- `reset` restores every recorded display facet, the kill facet of every package a manufacturer
  profile applied to that still has a change recorded (plus `appId`), then the keyboard profile
  active before the first manufacturer profile; the result names it as `manufacturerProfileId`.
  The display and kill records are shared with `displayProfile` and `killProfile`, so reset also
  restores direct `displayProfile` changes and the device-wide battery and Doze state. A facet
  the device refuses stays recorded and the reset is an error.
- In a daemon session (`sessionUuid`), release or rebind restores the kill and display facets,
  as with `killProfile` and `displayProfile`. The keyboard profile is restored only by `reset`,
  as with `keyboard` `setProfile`, so it stays active for the device's next session until then.
  The record is in memory only. The shared `platform` and `keepScreenAwake` device options apply
  as for other tools.

### System alerts (`systemAlerts`)

`systemAlerts` (opt-in with `setToolEnabled`) sets how OS permission and system alerts are
handled around each UI interaction on a device (#14106): `tapOn`, `tapAt`, `tapAny`, `swipeOn`,
`swipeAt`, `sendKeys`, `pressButton`, `dragAndDrop`, `dragPath`, `pinchOn` and `multiTouch`,
including the same tools run as `executePlan` steps. The check runs before the interaction, so
it reaches the app, and again after it, so a prompt the interaction raised is answered even when
no gated step follows. On iOS that covers SpringBoard alerts such as the location, camera,
contacts, notification and tracking prompts; on Android, the permission controller's grant
dialogs.

```ts
systemAlerts({ action: "setPolicy", policy: "allow" });
systemAlerts({
  action: "setPolicy",
  policy: "deny",
  match: [{ textContains: "Kamera", buttonText: "Erlauben" }],
});
systemAlerts({ action: "get" });
systemAlerts({ action: "clear" });
```

- `action` is `setPolicy`, `clear` or `get`; `get` and `clear` take no other arguments.
- `policy` (setPolicy only) defaults to `report`, which never taps and surfaces the alert in the
  action's `warnings`. `allow` taps the grant button ("While using the app" or "Allow While Using
  App" where offered), `deny` taps the refusal ("Don't allow", or "Ask App Not to Track"), and
  `allowOnce` taps the one-time grant, falling back to `allow` when the alert has none.
- `match` (setPolicy only) answers specific alerts by label: `buttonText` names the button to
  tap, in any language and on any alert, and an optional `textContains` limits the entry to
  alerts whose text contains that string. Labels compare case-insensitively. An alert no entry
  answers falls back to `policy`; a `buttonText` such as "OK" also taps an app's own alerts.
- Android buttons are recognized by their permission-controller resource ids, so any device
  language works. iOS buttons are recognized by their English labels, and an alert counts as a
  permission prompt only when it offers a refusal ("Don't Allow" or "Ask App Not to Track").
  Any other alert, including an app's own alert or a prompt in another language, is reported as
  an unmatched "alert" and never tapped unless a `match` entry names its button.
- Every alert the check sees or answers is reported in the interaction's `warnings`, and every
  answer is logged; composite tools such as `navigateTo` and `setUIState` drop their inner
  steps' warnings, so the daemon log is the record there. Up to three back-to-back alerts are
  answered per check. A failed read or tap is a warning and never blocks the action, and the
  action's own `observation` is taken before the after-action check, so it can still show an
  alert the warnings say was answered. With no policy set, no check runs.
- The answers are not part of a recorded plan: `recordToolCalls` records `setPolicy` (not
  `get`), so a plan replays the policy only when it was set while recording.
- In a daemon session (`sessionUuid`), the policy belongs to the session and clears when it is
  released or moves off the device. A sessionless policy persists until `clear` or until the
  device disconnects. The policy is kept in daemon memory, so a daemon restart clears it. The
  shared `platform` and `keepScreenAwake` device options apply as for other tools.

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
restore light appearance, and restores the content size category `displayConfig`
replaced before its first text-size write in this process, kept the same way.
Failed `displayConfig` results set MCP `isError: true`.

On physical iOS devices (#14092), `displayConfig` reads and sets the light/dark
theme through the CtrlProxy runner's `request_appearance` command, which uses
XCUITest's `XCUIDevice.appearance`. Apple documents it as settable from iOS 15 and
Xcode 16.3 (XCUIAutomation); the runner targets iOS 17 and builds with Xcode 26.5.
`fontScale` and `density` stay unsupported on physical iOS devices (and `density` on the Simulator). `reset` restores
the appearance `displayConfig` first replaced on that device in this process (light
when none was recorded), and session release restores the recorded value through
the same path. A runner that predates `request_appearance` returns a failure that
names the command. Whether the appearance persists after the runner exits has not
been verified on hardware.
`shake` runs on the iOS Simulator and Android emulator only: physical iOS devices have no XCTest shake API and physical Android devices have no emulator console, so both are refused with an error before any command runs. `shake.duration` is an integer from 1 to 1,798,000 ms (default 1000); the maximum leaves 2 seconds for action-timeout overhead under the 30-minute MCP request limit. Invalid values are rejected before shaking. `shake.intensity` is an Android acceleration value from 1 to 1,000 (default 100); iOS ignores it. The maximum is a conservative bound because the repository does not define an emulator sensor limit. Android shake restores the acceleration vector read before the shake; when read-back fails, it uses the issue-reported emulator resting vector `0:9.77622:0` and includes `restoreWarning` in the result.

`setSensor` drives the Android emulator console (`adb -s <serial> emu sensor set <sensor> <a[:b[:c]]>`), the same path `shake` uses for acceleration. Each `sensor` takes a fixed number of values in a sanity range: `acceleration` (x, y, z in m/s², ±1000), `gyroscope` (rad/s, ±100), `magnetic-field` (µT, ±2000), `orientation` (azimuth 0..360, pitch −180..180, roll −90..90 degrees), and single values for `temperature` (°C, −273.15..1000), `proximity` (cm, 0..100), `light` (lux, 0..200000), `pressure` (hPa, 0..2000) and `humidity` (%, 0..100). Values are rounded to 6 decimal places. A wrong arity or out-of-range value is rejected before any console command. The tool reads the current value first and refuses to write when the console cannot read it (for example a sensor the AVD disables), so it never changes a sensor it cannot restore. The result reports `previous` (read before the call), `applied` (what was written), `changed`, `reset`, and, while a restore slot remains, `restore: { value, onSessionRelease }`. The slot holds the value read before the first change and is never overwritten by later calls; `reset: true` writes it back and clears it, and setting the original value again also clears it. With nothing recorded, `reset: true` reads the sensor and reports `changed: false`. Within a daemon session (`sessionUuid`), release or rebind writes back every recorded sensor on that device, bounded to 1 second per sensor; the device stays quarantined until the writes settle. A session that changes a sensor also takes over values a sessionless call recorded on that device, so its release returns the device to the values found before AutoMobile changed them. Sessionless changes persist until `reset`. The slots live in daemon memory: a daemon restart loses them, and the emulator keeps the last value until it is cold-booted. Physical Android devices and iOS are refused with an error naming the emulator requirement. Console acceptance is not a read-back: whether an app reacts depends on its sensor listeners (for example, `proximity` 0 turns the screen off only while an app holds a proximity wake lock, such as during a call). Read current values with `getDeviceState` `include: ["sensors"]`.

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

On the iOS Simulator, text size is a Dynamic Type category set with
`simctl ui <udid> content_size` (#14087). A read reports `contentSize` and the
`fontScale` derived from it. `fontScale` selects the category whose body text
scale is nearest (a tie picks the larger one; `"default"` is `large`), and
`contentSize` selects one exactly; send only one of them. `previous` carries
`theme` and `contentSize`, never the derived scale, so it can be sent back as is.
Android refuses `contentSize`.

| `contentSize`                           | Body text | `fontScale` |
| --------------------------------------- | --------- | ----------- |
| `extra-small`                           | 14 pt     | 0.82        |
| `small`                                 | 15 pt     | 0.88        |
| `medium`                                | 16 pt     | 0.94        |
| `large` (default)                       | 17 pt     | 1           |
| `extra-large`                           | 19 pt     | 1.12        |
| `extra-extra-large`                     | 21 pt     | 1.24        |
| `extra-extra-extra-large`               | 23 pt     | 1.35        |
| `accessibility-medium`                  | 28 pt     | 1.65        |
| `accessibility-large`                   | 33 pt     | 1.94        |
| `accessibility-extra-large`             | 40 pt     | 2.35        |
| `accessibility-extra-extra-large`       | 47 pt     | 2.76        |
| `accessibility-extra-extra-extra-large` | 53 pt     | 3.12        |

#### displayConfig accessibility display preferences

`displayConfig.increaseContrast`, `reduceMotion` and `boldText` are optional
booleans (#14088). A read returns them in `current`; a set returns `previous` and
the read-back `applied` values. `supported` reports each one per target: `true`
when the write is proven by reading the setting back, `"partial"` when the stored
setting reads back but running apps may not observe it, and `false` when there is
no path. `supportNotes` gives the reason for every `partial` or `false` field.
`reset` restores each preference `displayConfig` changed earlier in this process
to the value it replaced, and acquisition-time reset (#11145) covers all three.

| Field              | Android                                                                                                                  | iOS Simulator                                                                                                            | Physical iOS |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `increaseContrast` | `true`: high-contrast text, `settings put secure high_text_contrast_enabled 1`                                           | `true`: `simctl ui <udid> increase_contrast enabled\|disabled`; `false` with simctl's error on an Xcode without the verb | `false`      |
| `reduceMotion`     | `true`: Remove animations, all three animation scales set to `0`; `false` restores the scales it replaced, otherwise `1` | `"partial"`: `defaults write com.apple.Accessibility ReduceMotionEnabled -bool YES` in the Simulator                     | `false`      |
| `boldText`         | `true` on API 31+: `settings put secure font_weight_adjustment 300`; `false` below API 31                                | `"partial"`: `defaults write com.apple.Accessibility EnhancedTextLegibilityEnabled -bool YES` in the Simulator           | `false`      |

On Android, `displayConfig` also reads and sets the display accessibility settings
(#14076). High-contrast text and Bold text are `increaseContrast` and `boldText` above.
Each is verified by reading the setting back, restored by `reset` and by acquisition-time
reset (#11145), and reported unsupported on the iOS Simulator:

| Field                | Android setting                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `colorInversion`     | `secure accessibility_display_inversion_enabled`                                                                                                                                                                          |
| `colorCorrection`    | `off`, `deuteranomaly`, `protanomaly`, `tritanomaly` or `grayscale`: `secure accessibility_display_daltonizer` (mode, written first) and `accessibility_display_daltonizer_enabled`; `off` keeps the device's chosen mode |
| `magnification`      | `secure accessibility_display_magnification_enabled`: the triple-tap gesture, which does not zoom until it is performed                                                                                                   |
| `magnificationScale` | `secure accessibility_display_magnification_scale` (1 to 8; AOSP default 2)                                                                                                                                               |
| `extraDim`           | API 31+: `secure reduce_bright_colors_activated`; below API 31 it is unsupported                                                                                                                                          |

Research outcome for the iOS Simulator `reduceMotion` and `boldText` fields:
partial with relaunch. simctl has no verb for either, so `displayConfig` writes
the `com.apple.Accessibility` default inside the Simulator and reads it back from
there. UIKit reads these preferences when an app launches, and no Darwin
notification is posted, so relaunch the app under test before observing the
change. A missing default reads as off, and reset deletes a default that was
absent before the first change. Android settings writes work on physical
devices too, because they are verified by the same read-back.

`phoneCall.phoneNumber` is required except for the hold action.
`sendSms.phoneNumber` specifies the sender's number.
On iOS both tools need the app under test to embed the AutoMobile iOS SDK in a
DEBUG build and be in the foreground: `phoneCall` reports the call through
CallKit, and `sendSms` posts an SMS-style local notification. Without the SDK
they return an error that says so.
`postNotification.channelId` supplies the Android channel ID, and the iOS APNs
category when `category` is omitted.

On the iOS Simulator (#14097), `postNotification` builds a `simctl push` payload:
`aps.alert` from `title`/`body` and `aps.sound: "default"`.

- `category` sets `aps.category`. An app that registered a `UNNotificationCategory`
  with that identifier shows the category's action buttons. `actions` cannot
  create buttons on iOS, so they are ignored with a warning.
- `imagePath` (a host path, resolved like Android's, or any URL) adds
  `aps.mutable-content: 1` and sends the image URL under the top-level key
  `automobile-image-url` (a host path becomes a `file://` URL). The image appears
  only if the app's Notification Service Extension downloads and attaches it, and
  the result carries a warning saying so.
- `payload` is a raw APNs JSON object for custom keys, `interruption-level`,
  `relevance-score`, `thread-id`, and similar. Its top-level keys and its `aps`
  fields override the generated ones; `Simulator Target Bundle` always names
  `appId`. The merged JSON must fit the 4096-byte `simctl push` limit; a larger
  payload is refused before `simctl` runs. Custom keys reach the app's
  `userInfo`.
- On Android, `category` and `payload` are ignored with a warning. Physical iOS
  devices remain unsupported: real APNs delivery is out of scope.

Live Activity research (#14097), unverified: `simctl push` addresses an app
bundle, while ActivityKit update and end pushes (`aps.event`, `aps.content-state`)
are addressed to an activity's push token on the
`<bundle>.push-type.liveactivity` topic. A `payload` carrying those fields is
therefore expected to arrive as an ordinary push to the app rather than update a
running Live Activity. This has not been confirmed against a current Xcode
Simulator; until it is, do not rely on `postNotification` to drive Live
Activities.

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

### Media session options

`mediaSession` is Android-only and runs plain adb: it reads
`dumpsys media_session` and drives `cmd media_session` (falling back to the
`media` shell tool on releases without that command). It needs no CtrlProxy, so
it uses booted-only readiness.

`action: "get"` returns `sessions` and `mediaButtonSession`. Each session has
`package`, `tag`, `userId`, `active`, `state` (`PlaybackState` lower-cased:
`playing`, `paused`, `stopped`, `buffering`, `none`, ...), `stateCode`,
`positionMs`, `positionUpdatedAtMs`, `speed`, `actions` (decoded
`PlaybackState.ACTION_*` names) and `metadata`. These are what the app last
reported to the system: `positionMs` is the position at `positionUpdatedAtMs`
(device `elapsedRealtime`), not a live playhead. The platform dump exposes only
the metadata key count (`size`) and its `MediaDescription`, so `title`, `artist`
and `album` are the description's three fields, split only when exactly three
are present; `description` keeps the raw text. Track duration is not in the dump
and is not reported. `appId` limits `sessions` to that package.

`waitFor: { mediaState, timeoutMs }` (only with `action: "get"`) polls until a
session (of `appId`, if given) reports `mediaState`, for up to `timeoutMs`
(default 5000). A timeout reports `awaitTimeout: true`, which fails the step in a
plan, so a plan can wait for playback to start:

```yaml
- tool: mediaSession
  params:
    appId: com.example.player
    action: get
    waitFor: { mediaState: playing, timeoutMs: 10000 }
- tool: mediaSession
  params:
    action: { dispatch: pause }
```

`action: { dispatch: key }` sends `play`, `pause`, `play-pause`, `next`,
`previous`, `stop`, `fast-forward` or `rewind` the way a headset or Bluetooth key
does: to the current media button session. The result names that session
(`dispatch.handledBy`) and its `previousState` and `state`, re-read for up to two
seconds until the state changes. With `appId`, the call is refused before
anything is sent unless `appId` owns the media button session. When the state
changed, `restore.dispatch` is the key that puts it back (`play`, `pause` or
`stop`); a track change from `next` or `previous` has no restore key.

`action: { volume: { stream, level } }` sets the `music`, `ring` or `alarm`
stream index. The current level and range are read first; a level outside the
range is refused without a change. The level is read back after the write
(`volume.verified`; a mismatch is `success: false`), and
`restore.volume` holds the previous level to pass back to restore it.

### Status bar overrides

`statusBar` makes screenshots, `snapshotOf` crops and video recordings repeatable by
pinning what the status bar shows (#14105). `action` is required:

- `override` sets the given fields and leaves the others as they are. At least one
  field is required. A later override from the same session merges with the
  earlier one.
- `clear` restores the live status bar (`simctl status_bar clear`, or the demo-mode
  `exit` command on Android).
- `get` reads the recorded override and the platform's own readback (`raw`):
  `simctl status_bar list` on iOS, `sysui_demo_allowed` on Android. `get` is a
  read; `override` and `clear` are control.
  Fields:
  | Field | iOS Simulator | Android demo mode | | ------------------- | --------------------------------------- | ---------------------------------------------------- |
  | `time` | Any text, e.g. `"9:41"` | `H:MM` or `HH:MM` (24-hour), sent as `hhmm` |
  | `batteryLevel` | 0-100 | 0-100 |
  | `batteryState` | `charging`, `charged`, `discharging` | `charging` sets `plugged true`, the others false |
  | `cellularBars` | 0-4 (sets `cellularMode active`) | 0-4 mobile `level` |
  | `wifiBars` | 0-3 (sets `wifiMode active`) | 0-3 Wi-Fi `level` |
  | `dataNetwork` | `wifi`, `5g`, `lte`, `4g`, `3g`, `hide` | `wifi` shows Wi-Fi; others set the mobile `datatype` |
  | `operatorName` | Carrier text | Unsupported: no demo-mode carrier command |
  | `hideNotifications` | Unsupported | Hides notification icons |
  A requested field the platform cannot set is skipped, listed in `unsupported`, and
  the result `status` is `"partial"` instead of `"applied"`. Physical iOS devices have
  no status-bar override and return `status: "unsupported"`. Physical Android devices
  use the same demo mode as emulators; OEM SystemUI builds may ignore some commands.
  An override set under a `sessionUuid` is owned by that session and cleared when the
  session releases the device or moves off it, before the next session can acquire
  it. An override from a call without a session is not cleared automatically; use
  `clear`.

### Window mode options

`windowMode` is Android-only and runs plain adb, so it uses booted-only readiness.
`appId` names the app whose task moves. Pass exactly one of `mode` and `restore`.
Each call reads `dumpsys activity activities` back after every command it runs and
reports the app task's `windowingMode`, `taskId` and `bounds` (display pixels), the
`previous` task window, the `method` (shell command) that reached the mode, and every
`attempts` entry. `success` is false, with a `reason`, when the read-back never
reached the request.

- `mode: "fullscreen"` returns the app to fullscreen; from split screen it asks the
  WM Shell to exit split first.
- `mode: { pip: "enter" }` brings the app forward and presses HOME. The app must
  support picture-in-picture and enter it on leaving (`setAutoEnterEnabled(true)` on
  API 31+, or `enterPictureInPictureMode()` from `onUserLeaveHint()`).
  `{ pip: "exit" }` relaunches the app fullscreen.
- `mode: { freeform: { bounds } }` turns on the global settings
  `enable_freeform_support` and `force_resizable_activities` when they are off,
  launches the app with `--windowingMode 5` (or, on API 35+, asks the WM Shell to move
  it to the desktop) and, with `bounds`, resizes the task with `am task resize`.
- `mode: { splitScreen: { with, position } }` splits the app with the `with` app.
  `position` is the app's side: `primary` (top or left, the default) or `secondary`.
  API 31 and below dock with `--windowingMode 3`/`4`; API 32+ use the WM Shell's
  `moveToSideStage` and need `with`. Split ratio is not settable.

`restore` is the receipt a call returned: `restore.mode` puts the window back where
it was, and `restore.settings` writes back the prior freeform setting values. The
settings receipt is refused on another device or after a reboot. `observe` reports
every task's `windowingMode` and `bounds` in `backStack.tasks`. Taps on observed
elements need no mapping in freeform or split screen: element bounds are already
absolute screen coordinates. See
[Android windowing](design-docs/plat/android/windowing.md) for the commands per API
level and what remains to verify on emulators.

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
existing MCP error response (Android provisioning retains the device/session). Unknown or
unsupported observations do not add `success: false` to the result; for `provisionDevice` on an iOS
Simulator they still fail provisioning with `resource_profile_unproven` and `resourceDrift` (no
session is bound). Existing mutation fields retain
their shape and meaning. Observation uses at most half the remaining resource deadline and shares the abort
signal; exhausted reads report `unknown`, and a repeated `provisionDevice` call refreshes it.
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

The iOS catalog (`automobile:devices/images/ios`, `provisioningCatalog.deviceTypes[]`) adds
`runtimeCompatibility` per model: `knowledge: "known"` with inclusive normalized
`minRuntimeVersion`/`maxRuntimeVersion` (`null` is an unbounded maximum) and
`compatibleRuntimeIds` (installed, available runtimes inside the bounds; empty is an authoritative
"none"), or `knowledge: "unknown"` with a `reason` when CoreSimulator evidence is missing or
malformed (it says nothing about which runtimes work). Exact iOS `provisionDevice` checks the
requested pair against the same evidence before any creation side effect and fails a proven
mismatch (or an unavailable runtime) with non-retryable `runtime_incompatible`; its
`runtimeCompatibility` diagnostic carries the requested pair, known `bounds`, and installed
`compatibleRuntimes`. Unknown evidence or failed discovery does not block creation. The requested
runtime or model is never substituted.

`provisionDevice` takes no idempotency key and keeps no per-request record: every call runs its own
lifecycle. A concurrent call for the same exact device waits on that device's lifecycle lease and then
adopts the device (or is refused by session ownership), so retrying never creates a second device.
`provisionDevice` error responses for daemon handoff (`daemon_handoff_interrupted`), caller
cancellation (`request_cancelled`), readiness failures, and cleanup failures (`boundary`
`readiness_failure` / `cleanup_failure`) carry a top-level `recovery` snapshot (`schemaVersion: 2`) next
to the existing `error` and `lifecycle` fields. `boundary` names where the call failed; `phaseReached` is
the last lifecycle phase the request recorded; `device` is the exact identity (`stableId`,
`runtimeDeviceId`) with `ownership` (`created_by_request`, `adopted`, or `unknown` when the request never
observed which); a display name alone never authorizes destructive recovery. `outcomes` reports
independent facts: `deviceCreation` (`created`, `adopted`, `not_created`, `unknown`) and `settlement`
(cancellation: `settling` or `settled` within the bounded 5 s wait). `cleanup.status` is `unnecessary`,
`pending`, `failed_device_retained`, `reported_complete_unverified` (a successful destroy is not verified
absence), or `unknown`. `originalError` preserves the provisioning cause. Select the recovery from
`nextAction.action`: `retry` (a fresh call; honor `retryAfterMs` when the cancelled work is still
settling or cleanup is pending, and `automaticRetrySafe: false` while cleanup is pending),
`reacquire_retained_device` (the created device still exists; retrying with the same device adopts it
without creating another), `perform_cleanup` (cleanup failed and the device is retained; use the exact
identity), or `obtain_further_evidence` (inventory first, also used when a readiness or cleanup failure is
not marked retryable, and when an iOS simulator create was still unsettled at rollback so the outcome is
`retained` with no `device` identity and `deviceCreation: unknown`; `automaticRetrySafe: false`). Missing
evidence stays `unknown`; the snapshot is stamped with `freshness.observedAtMs` and daemon build, and
a response that is lost in transit leaves the caller without it. Gathering it reads only in-memory
state and does not extend the request deadline.

`deleteDevice` has no caller-supplied operation ID and stores no replayable
result: each call runs its own teardown under the device lifecycle lease, and
a repeated call on an already-removed device reports `already_absent`. `verifyAbsence` requires a complete inventory observation proving
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
`unhealthy: { reason, since }`. Reasons are `biometric-enrollment`, `network-condition`, `clock`,
`keep-screen-awake` (a session's keep-awake setting could not be restored), or
`app-cleanup` (an `executePlan` app cleanup did not complete); `since` is the daemon's timestamp in milliseconds. Unresolved restore failures
exclude devices from available/idle counts and new session allocation. Biometric,
network, keep-awake, and app-cleanup failures get three background recovery opportunities with 1s/2s/4s backoff;
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

| Tool                                                           | What it does                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 🌐 <code>network</code>                                        | Controls network capture and error simulation.                                            |
| 🎭 <code>mockNetwork</code> / 🧹 <code>clearMockNetwork</code> | Adds or clears mock network response rules.                                               |
| 🕸️ <code>getNetworkGraph</code>                                | Returns the aggregate captured network graph.                                             |
| 🧪 <code>executePlan</code>                                    | Executes YAML plan steps and stops at the first failure.                                  |
| 🔒 <code>criticalSection</code>                                | Synchronizes devices, then runs steps serially.                                           |
| 🚧 <code>barrier</code>                                        | Synchronizes devices, then lets them proceed concurrently.                                |
| 📝 <code>recordToolCalls</code>                                | Records MCP tool calls to YAML; begin and end require <code>--tool-call-recording</code>. |
| ⏺️ <code>recordDeviceGestures</code>                           | Records on-device user input (not tool calls) for <code>exportPlan</code>.                |
| 📤 <code>exportPlan</code>                                     | Stops the active recording and exports a YAML plan.                                       |
| 🎥 <code>videoRecording</code>                                 | Starts or stops device video recording.                                                   |
| ⏱️ <code>performanceTrace</code>                               | Records a native trace (xctrace on iOS, Perfetto on Android) and returns a summary.       |

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

`recordToolCalls.planName` names the plan for `action: "end"`. The end response
carries a `warnings` list when a call was skipped (a file-staging call with a
host `sourcePath`, or a param over 64 KiB) or recorded in a weakened form:
`resetKeychain` is recorded with `confirm: false`, so a replay stops at that
step until you set `confirm: true` in the plan by hand. A recording whose calls
were all skipped fails with an error that lists them.
`exportPlan.recordingId` identifies the recording to export, and `planName`
names the exported plan.

Device gesture recordings capture input made on the device itself: touches on its touch
screen or emulator window, and text changes in input fields. A text change is recorded whatever produced it,
so text typed by a tool becomes a `sendKeys` step. Taps, swipes and
other gestures sent through AutoMobile tools (`tapAt`, `tapOn`, `swipeOn`, etc.)
or `adb shell input` are injected and are not recorded by design; use
`recordToolCalls` to record tool calls. Recording status always reports
`captureScope: "user-input"` and includes a `notice` while `eventCount` is zero.
A stop or `exportPlan` with no captured input fails with
`reason: "no_user_input_captured"` and the same explanation; touch-track or
recorder-stop failures retain their own errors.

### Performance traces

`performanceTrace` is disabled by default; enable it with `setToolEnabled`.
`action: "start"` takes a `template` (`appLaunch`, `hitches`, `hangs`,
`timeProfiler`, or `allocations`), an optional `appId`, and an optional
`timeLimitMs` (1000–300000, default 30000). The recorder stops itself at the
time limit. `action: "stop"` takes the `traceId` that start returned and returns
the `artifactPath` with a bounded `summary`: `durationMs`, plus `launch`,
`hitches`, `hangs`, `topFunctions`, or `allocations` depending on the template.
The summary never includes raw tables. Anything that limited the summary is
reported in `warnings`.

- **iOS** (Simulator and device) runs `xcrun xctrace record` with the matching
  Instruments template (App Launch, Animation Hitches, Hangs, Time Profiler,
  Allocations). `appLaunch` launches `appId` under the recorder. Other templates
  attach to the running app, or record all processes when it is not running;
  `allocations` requires it to be running. Stop sends SIGINT so xctrace
  finalizes the `.trace`. The summary is read with `xctrace export`.
- **Android** runs `perfetto --background` with a template-mapped config
  (atrace categories, FrameTimeline, `linux.perf` sampling, or heapprofd), then
  pulls the `.perfetto-trace` to the host. The summary needs Perfetto's
  `trace_processor_shell` on the host `PATH` (or `AUTOMOBILE_TRACE_PROCESSOR`);
  without it, only the artifact is returned, with a warning.

Only one trace records per device at a time. Releasing the owning session (the
call's `sessionUuid`), or losing the device (its `deviceId`, or the device chosen
by `platform`), stops the recorder, so no `xctrace` or `perfetto` process
outlives the session. Artifacts are stored under the AutoMobile data directory
in `performance-traces/`, next to `video-archive/`.

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

| Tool                                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ♿ <code>accessibility</code>       | Reads or controls Android TalkBack and iOS VoiceOver, returning fresh device state regardless of feature flags; when `force-accessibility-mode` or `accessibility-auto-detect: off` changes what the action tools assume, `detectionOverride` names it. After enabling TalkBack, reports a detected blocking system runtime permission prompt via `warning` and `blockingPrompt`; AutoMobile does not dismiss it. Use `observe`, then `tapOn` to answer it. |
| 🎯 <code>accessibilityFocus</code>  | Sets or clears Android TalkBack focus by resource ID, text, or content description.                                                                                                                                                                                                                                                                                                                                                                         |
| 🧭 <code>accessibilityAction</code> | Performs an Android accessibility action (expand, collapse, dismiss, select, scroll or page in a direction, press and hold, set progress, or an app-defined custom action by label) on an element, the way TalkBack or Switch Access does.                                                                                                                                                                                                                  |
| 🔍 <code>accessibilityAudit</code>  | Runs the platform's own accessibility audit on the current screen: XCUITest `performAccessibilityAudit` on iOS 17+ (Simulator and physical). Android returns `errorCode: unsupported_platform` for now.                                                                                                                                                                                                                                                     |
| 🧪 <code>audit</code>               | Runs the accessibility (WCAG), performance or memory audit on the current Android screen on demand, with every audit feature flag off; supports container scoping, named baselines and `failOn` for plan assertions.                                                                                                                                                                                                                                        |
| 🔀 <code>setToolEnabled</code>      | Controls which AutoMobile tools appear in `tools/list` for the current MCP session; an omitted tool remains callable directly by name through `tools/call` — one exact name via `toolName`, or a batch via `toolNames`; unknown or hidden names reject the batch, while always-on names are returned in `skipped`.                                                                                                                                          |

### accessibilityAction

`accessibilityAction` performs an accessibility action on an Android element through the
CtrlProxy accessibility service (#14077), instead of a coordinate gesture. Target the element
with `resourceId`, `text` or `contentDesc`; it must resolve to a unique resource-id. `action`
is one of `expand`, `collapse`, `dismiss`, `select`, `clear_selection`, `show_on_screen`,
`scroll_forward`, `scroll_backward`, `scroll_up`, `scroll_down`, `scroll_left`,
`scroll_right`, `page_up`, `page_down`, `page_left`, `page_right` (API 29+),
`press_and_hold` (API 30+), `set_progress` (with `progress`, in the control's own range)
or `custom` (with `customAction`, the label of an app-defined action such as a Compose
`customActions` entry; matched exactly, then ignoring case).

An action the element does not offer is refused, and the error lists the actions it does
offer, with app-defined ones as `custom:<label>`. An action newer than the device's API level
is refused with the level it needs. The tool requires a CtrlProxy APK that advertises
`semantic_node_actions_v1`; with an older APK it fails before sending anything and asks for
a daemon restart so the current APK is installed. iOS is not supported.

### audit

`audit` runs the existing audit engines on the current Android screen when asked (#14075),
instead of only as a side effect of `observe` behind the `accessibility-audit`,
`ui-perf-mode` and `mem-perf-audit` feature flags. It never reads or changes flag state,
except that the WCAG level and failure mode follow the `accessibility-audit` config when it
is set (WCAG AA otherwise).

- `kinds`: `accessibility` (default), `performance`, `memory`.
- `appId`: the package to audit; defaults to the foreground app. The performance audit
  measures the foreground app, so a background `appId` reports it under `unsupported`.
- `scope.container`: `{ elementId }` or `{ text }`. Limits the accessibility audit to
  violations inside that element's bounds.
- `baseline`: `{ name, mode }`. `record` saves the accessibility violations under `name`;
  `compare` returns `baselineDiff` (`new`, `fixed` fingerprints, `unchanged` count) and only
  new violations count toward `failOn`.
- `failOn`: `error`, `warning` or `never` (default). When findings reach that severity,
  or a performance or memory audit fails, the call returns `failed: true` as an error,
  so a plan step can assert "no new accessibility violations".

Accessibility violations carry the element from the same observation (`resource-id`,
`bounds`). The output keeps the 50 most relevant (`totalViolations` and `truncated`
report a clip). iOS reports every kind under `unsupported`; use `accessibilityAudit` there.

### accessibilityAudit

`accessibilityAudit` runs the platform's own accessibility engine (#14086). On iOS 17+
(Simulator and physical device) the runner calls XCUITest's
`performAccessibilityAudit` on `appId` or the foreground app, and collects every issue
instead of failing on the first. `checks` selects `contrast`, `hitRegion`,
`dynamicType`, `textClipped`, `sufficientDescription`, `trait` and
`elementDetection` (default `all`). Each issue reports its `check`, a `summary` and
`detail`, and, when XCUITest names the element, its accessibility identifier as
`elementId` (accepted by `tapOn` and `highlight`), its `label` and its `bounds`.
`maxIssues` (default 50) bounds the output; `totalIssues` and `truncated: true` report
a clip. `unsupportedChecks` lists checks the target could not run.

It differs from the host-side WCAG audit (`WcagAudit`, the `accessibility-audit`
feature flag), which applies heuristics to the observed hierarchy and screenshot. The
platform engine instead sees what the OS sees: real hit regions, Dynamic Type support,
clipped text, trait misuse and elements it cannot detect.

A runner built before this command returns `errorCode: unsupported_capability`
rather than timing out; restart the daemon so it installs the current runner. On
Android the Accessibility Test Framework audit is not available yet, so the tool
returns `errorCode: unsupported_platform` and points to the WCAG audit.

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

Action-observation diffs always ship beside the current `skeleton` (the rows
above), so they carry no `added` or `removed` node lists: a node that appeared is
a skeleton row, and one that disappeared is simply absent from it. Only `changed`
entries (what moved from what) remain. Their `fields.layoutWarnings` value is an `{ added, removed }` pair
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
existing runner connection is open, with storage inspection enabled. Storage access
itself never starts a runner; tool target resolution may run the readiness described in
[Reading a device you do not own](#reading-a-device-you-do-not-own-deviceid).
SDK requests are bounded to 2.5 seconds. An SDK missing key
is authoritative. Reads may fall back after a recognized SDK timeout, transport
loss, missing route, or inspection-disabled response. Unknown faults, app mismatch,
and mutation refusals surface as errors.

On physical iOS devices (#14093), the embedded SDK is the only route: devices expose
no container plist or `defaults` store to fall back to. Reads and writes go through
an open SDK connection with storage inspection enabled, exactly as on simulators,
and `appId` is required. Without a connection, both tools fail with an error that
names the SDK requirement. Every SDK failure is final, so a write is attempted at
most once and never retried through another route.

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
unless `--tool-results-no-structured-content` is enabled. Both strip `extras` by
default; where supported, `includeExtras: true` retains them only in structured
content. Errors carry their JSON error detail in `content[0].text`. Each schema requires
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

`pressButton` `action` and `camera` press the iOS Action button and Camera Control
through XCUITest's `XCUIDevice.Button.action` and `.camera` (#14100). Apple
documents both cases, and `XCUIDevice.hasHardwareButton(_:)` (iOS 16+), in
XCUIAutomation for Xcode 16.3 and later; the runner presses only when
`hasHardwareButton` reports the button. Devices without the hardware (Action
button: iPhone 15 Pro and later; Camera Control: iPhone 16 and later) and
simulators whose runtime does not report it return `code: "unsupported_button"`
with `retryable: false`. Android has no equivalent and refuses both with the same
code. A press can launch the app or shortcut the user bound to the button, so
both count as navigation buttons.

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
`biometrics`, `networkCondition`, `clock`, `screenLock`, and (writes only) `location`. Reads may
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

### Long-running calls as MCP tasks

AutoMobile implements the [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
(`io.modelcontextprotocol/tasks`, #4668) on the daemon's MCP endpoint. A tool that opts in can
answer a `tools/call` with a task handle instead of blocking. `startDevice`, `executePlan` and
`installApp` opt in; recording start and stop follow. Short interaction tools stay synchronous.

To opt in, a client declares the extension on **every request** that may return a task, and on
every `tasks/*` request, in the per-request capabilities:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "startDevice",
    "arguments": {},
    "_meta": {
      "io.modelcontextprotocol/clientCapabilities": {
        "extensions": { "io.modelcontextprotocol/tasks": {} }
      }
    }
  }
}
```

- A client that also lists the extension in its `initialize` capabilities sees
  `capabilities.extensions["io.modelcontextprotocol/tasks"]` in the `initialize` result. The
  daemon speaks the 2025-era protocol, where `server/discover` does not exist. This is an
  AutoMobile extension of the spec: SEP-2663 leaves the Tasks extension undefined on
  `2025-11-25`, but AutoMobile advertises and serves it on the 2025-era `initialize` to any
  client that declares it, whatever `protocolVersion` that client sent (owner decision, #13143).
- Tasks belong to the session key (the `x-auto-mobile-mcp-session-id` header). A request without
  one always runs synchronously, and another session key cannot read or cancel the task.
- An opted-in call answers `{"resultType": "task", "taskId": …, "status": "working", "ttlMs":
  null, "pollIntervalMs": 1000, …}`. Poll `tasks/get` with `{"taskId": …}` at `pollIntervalMs`.
  `completed` carries the same `result` the synchronous call returns (including an `isError`
  result), `failed` carries the JSON-RPC `error`, and `input_required` carries `inputRequests`
  to answer with `tasks/update` (`{"taskId": …, "inputResponses": {…}}`).
- `tasks/cancel` is cooperative: it is acknowledged at once and the running tool is aborted;
  the task then reports `cancelled`, or `completed` if the tool had already finished.
- While a `startDevice` task is `working`, the daemon heartbeats the session it bound, so the
  client need not heartbeat a session it has not seen yet. Once the task is terminal, the
  client heartbeats that session as after a synchronous `startDevice`. Cancelling during the
  boot stops it and leaves no session bound, as cancelling a synchronous call does.
- While an `executePlan` task is `working`, the daemon heartbeats the plan's session and, for a
  multi-device plan, each label session once it is allocated; the plan keeps its session's plan
  lock as a synchronous plan does. `tasks/cancel` aborts the running step, unwinds the plan as a
  cancelled request would (its cleanup and session release still run) and releases the lock.
  A plan whose steps fail completes with the same `isError` result as the synchronous call;
  a call the synchronous path answers with a JSON-RPC error (invalid arguments, for one)
  reports `failed` with that error.
- An `installApp` task holds the session it installs onto while `working`. `tasks/get` settles
  with the same result the synchronous call returns (a failed install is a completed task whose
  result has `isError: true`). `tasks/cancel` aborts the `adb install` / `simctl install` process;
  the task reports `cancelled` and the installed-app inventory is re-read. An APK only partly
  transferred is never committed: the device discards the abandoned install session, so the
  previously installed version (if any) stays as it was. If the transfer had already finished and
  the device was committing, the install may still land; the re-read inventory shows the truth.
  The Android uninstall-and-reinstall downgrade recovery, once its uninstall has run, finishes the
  reinstall even if cancelled, so the app is not left removed.
- A finished task stays readable for 10 minutes (its `ttlMs` is then set, counted from
  creation); afterwards `tasks/get` answers `-32602` "Task has expired" or "Task not found".
- Tasks survive a daemon restart: a restarted daemon still answers `tasks/get`, and a task that
  was running when the daemon stopped reports `failed` with an "interrupted" error.
- `tasks/*` requests without the per-request declaration answer `-32021` (Missing Required
  Client Capability). Progress ticks of a task become its `statusMessage`; no
  `notifications/progress` is sent for a task.
- The stdio proxy relays the extension: it advertises it to a client whose `initialize` declared
  it, forwards each request's declaration and the `tasks/*` requests to the daemon, and answers
  with the daemon's results and errors unchanged. Its tasks belong to the proxy process rather
  than to one daemon connection, so polling keeps working after the proxy reconnects.
- A device-binding call (`startDevice` today) runs as a task through the proxy too. The proxy
  binds the device session when a `tasks/get` first reports the task `completed`, before it
  answers that poll, exactly as it binds from the synchronous result; later tool calls route to
  that session. It binds once per task, however often the task is polled and across proxy
  reconnects. A `failed` or `cancelled` task binds nothing, and neither does a session the daemon
  released before the completed poll (that poll answers an error). Poll the task to completion:
  until then the proxy holds no binding for it, and the proxy stops waiting on a task left
  unpolled for 10 minutes. A synchronous `startDevice` re-checks a device still finishing its
  previous session's cleanup; as a task, that refusal is the task's result.

## Checks

Devices advertising `prototype_checks_v1` evaluate declarative checks locally. The host refuses
show and patch results using this feature on older devices. Inputs `textField`, `slider`,
`checkbox`, `switch`, `radioGroup`, `datePicker` and `timePicker` accept `checks` (1–8 entries)
and `validateOn: "change" | "blur" | "submit"` (omitted means blur). Each check contains a
nonempty `message` and exactly one rule. `validateOn` controls error display, never validity.
The first failing message is displayed.

- `required: true`: trimmed nonempty text, true for checkbox/switch, nonempty selection for
  radioGroup/datePicker, present number for slider/timePicker.
- `minLength` / `maxLength`: nonnegative integer UTF-16 lengths, textField only.
- `min` / `max`: finite numeric inclusive bounds, slider and pickers only. Text fields hold
  strings and have no numeric subtype. Date state remains YYYY-MM-DD; bounds are UTC epoch
  milliseconds. Time pickers retain hourKey/minuteKey; checks apply independently to both keys.
- `format`: textField only, one of email, phone, digits, decimal, url.
- `pattern`: textField only, the restricted grammar below, at most 128 UTF-16 units.

Empty string, null or missing value passes all rules except required. Whitespace is only empty
for required. Pattern and format matching use at most 4096 UTF-16 units. Required and length checks inspect the complete value.
Every validity reference must name declared state with at least one check. Multiple checked
controls sharing a key must all pass. Numeric/length lower bounds must not exceed upper bounds.

Formats use these exact whole-value expressions (ASCII digits):

- email: `[^\s@]+@[^\s@]+\.[^\s@]+` (Unicode names allowed).
- phone: optional leading +, then 7–15 characters from ASCII digits, space, hyphen and parentheses;
  at least seven digits. The leading + is outside the character count. Punctuation need not balance.
- digits: `[0-9]+`.
- decimal: `-?[0-9]+(\.[0-9]+)?` (no exponent or leading +).
- url: `https?://[^\s/?#]+([/?#]\S*)?` (lowercase scheme, Unicode hosts allowed).

Format whitespace follows JavaScript whitespace (including NBSP); no format trims its value.
Patterns use ASCII `\d`, `\w`, `\s` and their complements `\D`, `\W`, `\S`; `\w` is
`[A-Za-z0-9_]` and `\s` is space, tab, CR, LF, FF, VT. Dot matches one Unicode scalar except
CR, LF, U+2028 and U+2029. Matching consumes the entire value, even with a final newline.
Allowed: literals, dot, classes `[abc]` / `[^abc]`, literal ranges, those six shorthand escapes,
escaped metacharacters, anchors ^ $, groups `(…)` / `(?:…)`, alternation |, and quantifiers
`? * + {n} {n,} {n,m}`. Every written bound is <=100 and n<=m; open upper bounds are unbounded.
Reject backreferences, lookahead/behind, named groups, lazy/possessive quantifiers, Unicode
properties, inline flags, word boundaries `\b` / `\B`, and every other escape (including
`\n`, `\x`, `\u`; use literal characters). Empty classes are rejected. A group repeated more
than once cannot contain alternation or any variable quantifier (maximum > minimum), transitively.
At most two variable quantifiers are allowed in the entire pattern: ? * + {n,} and {n,m} when
m>n. Fixed {n} quantifiers inside repeated groups remain allowed.
Thus `(a|b)+`, `(a+)+`, `(a*)*` and `((ab)+)+` are rejected. Optional groups remain allowed.
These exact rules and error substrings are pinned in the language-neutral checks fixtures.

Conditions `{valid: "email"}` and `{valid: ["email", "password"]}` mean all referenced keys
are valid, including fields whose errors are not yet shown. They compose with all/any/not in
visibleWhen, styleWhen and enabledWhen. enabledWhen is supported on the seven input types plus
button, iconButton, fab, chip and listItem; false disables the control and skips its onTap.
`emit` may specify `requireValid: ["email", "password"]` (1–8 keys). Any failing key aborts the
whole action list atomically, shows errors on every listed field, and sends
`{kind:"validation_failed", keys:[…]}` naming only the failing keys. `change` events carry
`validity: {key:boolean}` for checked keys. Both event kinds retain the usual event envelope.
