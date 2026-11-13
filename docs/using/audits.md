# Accessibility and performance audits

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
`screenId`, and `failed` when `failOn` matched. With `baseline` compare, `baselineDiff` lists `new`
violations, `fixed` fingerprints and the `unchanged` count, and only new violations count toward
`failOn`; a missing baseline is an error, so record one first. A cancelled call never records a
baseline. A `scope.container` that matches no
element is an error. The audit reads the screen on display, so an `appId` that is not in the
foreground is an error: bring the app to the foreground first, or omit `appId`.

**platform** (iOS 17+, Simulator and physical) runs XCUITest `performAccessibilityAudit`. The
result has `issues` (each with `check`, `summary`, `elementId` usable with `tapOn`, and `bounds`),
`totalIssues`, `truncated` and `unsupportedChecks`. As with `wcag`, an `appId` that is not in the
foreground (in the background or not running) is an error: bring the app to the foreground first,
or omit `appId`.

`errorCode` is `unsupported_platform` for `wcag` on iOS and for `platform` on Android (the Android
Accessibility Test Framework engine is not available yet), and `unsupported_capability` when the
iOS runner predates the audit command: restart the daemon so it installs the current runner.

```yaml
- tool: accessibilityAudit
  params:
    baseline: { name: checkout, mode: compare }
    failOn: error
```

## `performanceAudit`

Android only.

| Parameter | Meaning                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `kinds`   | `performance` and/or `memory` (default: both)                                                           |
| `appId`   | App to audit (default: the foreground app)                                                              |
| `failOn`  | `error` or `warning` fails the call when a check does not pass or cannot run; `never` (default) reports |

`performance` measures UI jank, frame time and touch latency of the foreground app against the
configured thresholds; when `appId` is not in the foreground it is listed under `unsupported`
instead, and `failOn` `error` or `warning` then fails the call. `memory` takes a memory snapshot of
`appId`. Each result has `passed`, its metrics and its violations; `failed` is set when `failOn`
matched. When the app rendered no frames during the check (an idle screen), the frame-time
percentiles `p50Ms`–`p99Ms` are null and `metrics.frameTimeUnmeasured` says why; frame time is then
not checked and does not fail the call. For raw captures use `performanceTrace`,
`captureTrace`, `measureStartup` or `heapDump`.

## audit (deprecated)

`audit` still returns the same results: `kinds: ["accessibility"]` matches `accessibilityAudit`
with engine `wcag` (nested under `accessibility`), and `kinds: ["performance", "memory"]` matches
`performanceAudit`. It will be removed; move plans to the two tools above.
