# Overview

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** Fully implemented. Observation includes typed, source-attributed inset data when the platform can provide it. See the [Status Glossary](../../status-glossary.md) for chip definitions.

Each observation captures a snapshot of the current state of a device's screen and UI. When executed, it
collects multiple data points in parallel to minimize observation latency. These operations are incredibly platform
specific and will likely require a different ordering of steps per platform. All of this is to drive the
[interaction loop](../interaction-loop.md).

All collected data is assembled into an object containing (fields may be omitted when unavailable):

- `updatedAt`: device timestamp (or server timestamp fallback)
- `screenSize`: current screen dimensions (rotation-aware)
- `insets`: typed safe-area and system-inset snapshot, including availability, source, units, system bars, cutouts, Android gesture regions, and current system-chrome visibility when available
- `systemInsets`: compatibility alias for the stable system-bar edges; prefer `insets` for new consumers
- `rotation`: current device rotation value
- `activeWindow`: current app/activity information when resolved
- `viewHierarchy`: complete UI hierarchy (if available)
- `focusedElement`: currently focused UI element (if any)
- `intentChooserDetected`: whether a system intent chooser is visible
- `wakefulness` and `backStack`: Android-specific state
- `deviceLock`: Android-specific `{ locked, keyguardShowing, secure? }` — present when the lock state could be read. Lets an agent detect it is looking at the keyguard rather than the app, and decide whether to dismiss a swipe lock itself or stop and ask the user for a PIN when `secure` is true. `secure` is omitted when it could not be determined over adb. When an interaction (tapOn, swipeOn, inputText, …) runs while the Android device is locked, its result also carries `deviceLock` plus a `deviceLockWarning` string, so a gesture that landed on the keyguard is never mistaken for a clean interaction with the app; the gesture is not blocked, so swipe-to-dismiss and PIN entry still work
- `displayedTimeMetrics` (Android launchApp "Displayed" startup timings), `performanceAudit`, and `accessibilityAudit`: present when the relevant modes are enabled
- `perfTiming`: collected internally for debug/perf capture diagnostics but stripped from the sanitized MCP tool output to reduce payload size
- `gfxMetrics`: emitted in sanitized output for action UI-stability summaries; frame timing fields may be trimmed when `performanceAudit.metrics` already carries non-null computed replacements
- `error`: error messages encountered during observation

Every observation includes report-only `layoutWarnings`. These flag text or interactive elements that may overlap safe areas, system bars, display cutouts, or Android gesture regions. Each warning includes `overflowPx` (how far the element extends into the unsafe region) and `insetPx` (the effective inset on that side), both in the observation's coordinate units. When a flagged descendant is fully contained by a flagged ancestor on the same unsafe side, the output keeps the descendant finding. Intentional edge-to-edge backgrounds and scrollable content remain advisory rather than failures.

`layoutWarnings` is capped at 100 entries (`MAX_LAYOUT_WARNINGS`); real screens flag only a handful, since only elements physically inside the thin inset strips are reported, so the cap trims only pathological hierarchies. When it does trim, the highest-severity, largest-overflow findings are kept and `layoutWarningsTruncated` is set to the **total number of warnings found before capping** — so the shown count is `layoutWarnings.length` and the number omitted is `layoutWarningsTruncated - layoutWarnings.length`. The field is absent when nothing was dropped.

When available, `insets.systemChrome` provides the system-chrome state that explains a
safe-area warning's screen context. Android reports the current visibility of the status
and navigation bars from `WindowInsets`; hidden bars do not become additional unsafe
regions. iOS reports actual status-bar visibility from the foreground `UIWindowScene` and
may include the visible controller's home-indicator auto-hide preference. That preference is
an app request, not proof that the home indicator is currently hidden. Older Android runners
and iOS apps built with an older AutoMobile SDK omit `systemChrome`, so clients must treat its
absence as unknown rather than inferring it from zero insets.

The observation gracefully handles various error conditions:

- Screen off or device locked states
- Missing accessibility service
- Network timeouts or ADB connection issues
- Partial failures (returns available data even if some operations fail)

Each error is captured in the result object without causing the entire observation to fail, ensuring maximum data
availability for automation workflows.

## See Also

- [Video Recording](video-recording.md) for setting up screen recording for later analysis.
- [WebRTC Streaming (WHIP)](webrtc-streaming.md) for pushing a live device stream to a MediaMTX WHIP/WHEP server and browser (e.g. from a CI worker).
- [werift H.264 packetization spike](werift-h264-packetization-spike.md) for the public-API feasibility decision behind the retained publisher packetizer.
- [Vision Fallback](vision-fallback.md) for how we fall back to LLM vision analysis when view hierarchy observation fails.
- [Visual Highlighting](visual-highlighting.md) for how we can draw on top of the observed app.
