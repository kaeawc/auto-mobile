# Accessibility and performance audits

| Tool                               | What it does                                                                                    | Platforms                                                                                                                                                   | Needs                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 🚦 <code>performanceAudit</code>   | Pass/fail performance checks of an app on the current screen, against the configured thresholds | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span></span> | <span class="tool-needs">—</span> |
| ✅ <code>accessibilityAudit</code> | Audit the accessibility of the current screen                                                   | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span></span> | <span class="tool-needs">—</span> |

Two tools check the current screen on demand and can fail a plan step: `accessibilityAudit` for
accessibility and `performanceAudit` for UI performance and memory. Neither changes feature-flag
state. Both are off by default; enable them with `setToolEnabled`.

## `accessibilityAudit`

| Parameter         | Engine   | Meaning                                                                                                     |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `engine`          | both     | `wcag` (host-side WCAG checks) or `platform` (the OS engine). Default: `wcag` on Android, `platform` on iOS |
| `appId`           | both     | App to audit (default: the foreground app)                                                                  |
| `scope.container` | wcag     | `{ elementId }` or `{ text }`: report only violations inside that element                                   |
| `baseline`        | wcag     | `{ name, mode: "record" \| "compare" }`: save violations, or report `baselineDiff` against them             |
| `failOn`          | wcag     | `error`, `warning` or `never` (default): fail the call when findings reach that severity                    |
| `checks`          | platform | iOS checks to run (default: all)                                                                            |
| `maxIssues`       | platform | Most issues to return, 1-500                                                                                |

Passing an argument of the other engine fails the call with an `error` naming it.

**wcag** (Android) checks contrast, touch targets, labels and headings. The result has
`violations` (each with its element and `fingerprint`), `totalViolations`, `truncated`, `summary`,
`screenId`, and `failed` when `failOn` matched.

With `baseline` compare, `baselineDiff` lists `new` violations, `fixed` fingerprints and the
`unchanged` count, and only new violations count toward `failOn`. A missing baseline is an error,
so record one first. A cancelled call never records a baseline.

A `scope.container` that matches no element is an error. The audit reads the screen on display, so
an `appId` that is not in the foreground is an error: bring the app to the foreground first, or
omit `appId`.

**platform** (iOS 17+, Simulator and physical) runs XCUITest `performAccessibilityAudit`. The
result has `issues` (each with `check`, `summary`, `elementId` usable with `tapOn`, and `bounds`),
`totalIssues`, `truncated` and `unsupportedChecks`. As with `wcag`, an `appId` that is not in the
foreground (in the background or not running) is an error: bring the app to the foreground first,
or omit `appId`.

`errorCode` is `unsupported_platform` for `wcag` on iOS and for `platform` on Android, which has no
platform engine. It is `unsupported_capability` when the iOS runner predates the audit command:
restart the daemon so it installs the current runner.

```yaml
- tool: accessibilityAudit
  params:
    baseline: { name: checkout, mode: compare }
    failOn: error
```

## `performanceAudit`

Both checks support Android and iOS Simulator. Calls on physical iOS devices fail.

| Parameter | Meaning                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `kinds`   | `performance` and/or `memory` (default: both)                                                           |
| `appId`   | App to audit (default: the foreground app)                                                              |
| `failOn`  | `error` or `warning` fails the call when a check does not pass or cannot run; `never` (default) reports |

`performance` measures UI jank and frame time of the foreground app against the configured
thresholds. Touch latency is measured on Android only. On iOS Simulator, instrument the app with
auto-mobile-sdk to report frame metrics. The check reports `unsupported` when the app is in the
background or the simulator receives no fresh frame metrics. Separately, `memory` takes a
snapshot of `appId` on Android and checks its RSS growth over three seconds on iOS Simulator.

Each result has `passed`, its metrics and its violations; `failed` is set when `failOn` matched.
On Android, frame-time percentiles and jank counts both cover only the frames rendered during the check, not
frames from app launch or earlier screens. When the app rendered no frames during the check (an idle screen), the frame-time percentiles
`p50Ms`–`p99Ms` are null and `metrics.frameTimeUnmeasured` says why. AutoMobile then skips the
frame-time check, so it does not fail the call. For raw captures use `performanceTrace` (its `categories` option records a custom Perfetto trace),
[`measureStartup`](#measurestartup) or [`heapDump`](#heapdump).

## Render overlays (iOS Simulator)

To see rendering cost in screenshots, turn on the Simulator's Core Animation overlays with
`displayConfig` `renderOverlays`, take a screenshot, then turn them off:

```json
{ "renderOverlays": { "blendedLayers": true, "offscreenRendered": true } }
```

| Overlay               | What the screenshot shows                       |
| --------------------- | ----------------------------------------------- |
| `blendedLayers`       | Opaque layers green, blended layers red         |
| `offscreenRendered`   | Off-screen rendered layers yellow               |
| `misalignedImages`    | Misaligned images magenta, scaled images yellow |
| `copiedImages`        | Images Core Animation copied cyan               |
| `cacheHits`           | Rasterized layer cache hits green, misses red   |
| `flashUpdatedRegions` | Regions flash yellow as they redraw             |

The result's `applied.renderOverlays` and `previous.renderOverlays` report every overlay, and a
read reports them under `current.renderOverlays`. The overlays tint every app on screen until you
turn them off, send `reset: true`, or shut the Simulator down. A session's keep-booted reset puts
them back the way it found them. Android and physical iOS devices refuse `renderOverlays`.

## `measureStartup`

Set `appId` to the package name or bundle ID and choose a startup `mode`. The tool is off by
default. Enable it with `setToolEnabled`. It measures five launches by default and saves TTID
percentiles in performance results. Set `iterations` to measure 1–50 launches.

On iOS Simulator, time to initial display (TTID) runs from FrontBoard's open request to the
default scene's first frame. In `cold` mode the app process is terminated before each launch
and the host page cache stays in place. In `warm` mode the app returns from Home with the same
process. The result warns if a warm launch changed processes or if a launch logged no
scene-ready event. The tool fails if every measured launch misses that event.

iOS Simulator accepts `cold` and `warm`. Use `warm` if you requested `hot`. The `activity`,
`dropCaches`, and `waitForFullyDrawn` options and compilation modes other than `asIs` are
Android-only. For a physical iOS device, use `performanceTrace` with `template: "appLaunch"`.

## `heapDump`

Launch the app, then pass its Android package name or iOS bundle ID as `appId`.
The result includes the host file `path`, its `sizeBytes`, and its `format`.

- Android writes an `.hprof` for a debuggable or profileable app. Set `native: true` to capture
  the native heap. `heap_dump_not_debuggable` means you need a debuggable or profileable build.
  `native_heap_dump_unavailable` means the device has no native heap to dump. Native dumps need
  malloc debug on a rooted device.
- iOS Simulator writes a `.memgraph` you can open in Xcode. Leave `native` unset. If you get
  `heap_dump_not_inspectable`, try a debuggable Simulator build. If the app stopped, relaunch
  it and retry.

`heapDump` is unsupported on physical iPhones. For allocation profiling on a physical iPhone,
attach to the running app with the Allocations template in Instruments (`xctrace`).
