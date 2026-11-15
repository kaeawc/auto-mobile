# Lifecycle and safety

Part of [the agent-authored prototype specification](prototype-ux.md).


Chromeless fullscreen is the default on a device advertising `prototype_window_chrome_v1` (#12064),
and the bar is opt-in. The host escape is a stationary two-finger long press (1 s) anywhere on the window that cancels authored touch handling for that gesture and
reveals a small dismiss pill for 5 s (a second hold restarts the timeout; a replacing show hides it). A
host-owned wrapper exposes the `Dismiss AutoMobile prototype` accessibility dismiss action without touch,
and touch exploration (TalkBack) keeps the pill permanently visible. Both dismiss with reason `user` and
stay usable at spec opacity 0. Back is not the exit: it only dismisses while a text field makes the window
focusable. Agent dismiss, a replacing show, authored dismiss, the five-minute idle TTL, last-client
disconnect and service teardown keep working. Home hides a session prototype when its app leaves the
foreground. A CtrlProxy without the capability keeps the bar and the host refuses explicit `none`.

With `none`, authored content fills the window including under the status bar (top content needs top-edge
`safeAreaPadding`; relative sheet detents use the full window height). With `bar` (also the older-device
fallback) a translucent host row stays above clipped authored content, independent of spec style and
opacity, and its height is excluded from the authored viewport. Both fullscreen modes keep window alpha at 1
and fade only authored content and its scrim.

The dismiss bar's button and the persistent (`persistence: "device"`) sheet and floating Close control are one
circular close chip (#15119), the twin of the iOS chip: a 32 dp opaque `prototypeCloseColors` fill with a
Close glyph, no text label, a 48 dp hit target, and the shared host id `automobile-prototype-dismiss`
(`testTag`, exposed as the resource id) with content description `Dismiss AutoMobile prototype`. The persistent
chip sits top-end inside the system-bar and cutout insets; the bar keeps its inset-aware row. The brief
chromeless escape pill keeps its text and carries the same id (#15120). The `automobile-` `testTag` prefix is
reserved on every platform (the validators reject an authored tag with it), observe sees the controls by that id,
and `tapOn` moves its point off them or fails naming the control that covers the whole target. Session-scoped sheets and floating windows still draw no host control
(they end through the agent's `dismiss`, a replacing show, the TTL or a disconnect).

A `persistence: "device"` prototype outlives its host session: it is not dismissed when the last client
disconnects (including a show queued after that edge), has no idle TTL, and keeps its assets until
dismissal. Because nobody may be connected to remove it, sheet and floating windows carry an opaque "Close"
control above the authored content, and opacity fades only the content. Fullscreen defaults to `bar`; a
device with `prototype_window_chrome_v1` also honours explicit `none` with the hidden escape. It ends
through that control, the dismiss row or pill (`user`), `dismiss_prototype` (`agent`), a replacing show, or
service unbind/destroy (`teardown`). Keyguard hiding is unchanged.

Events a persisted prototype emits while no client is connected (checked per event
against the live client count) go to a bounded ring in `PrototypeController`
(`PrototypeOfflineEventBuffer`, 200 events, oldest dropped and counted). The ring
is flushed under the controller mutex, so order is preserved: when a client
connects (`onClientConnected`), before the next live event, and before an
`inspect_prototypes` reply. Session-scoped prototypes never use it. `inspect_prototypes`
returns one `prototype_result` with `prototypes` (`id`, `persistent`, `state`,
`pages`, `lastSequence`) and `droppedEvents`, the cumulative count dropped from
the ring. The host adopts the report into its status store and event buffers,
because the host clears both on session release. Both behaviours are advertised
as `prototype_persistence_replay_v1`; a host refuses `inspect` without it.

Every dismissal emits one `prototype_event` with `kind: "dismissed"`, null `name` and
`payload: {"reason": "user|agent|disconnect|ttl|teardown"}`. Host and authored dismiss controls use `user`;
`dismiss_prototype` `agent`; last-client disconnect `disconnect`; idle expiry `ttl`; service teardown,
unbind/restart and owning-display removal `teardown`. Sequence allocation precedes delivery even with no
socket. A show replacement closes the old runtime silently and cancels its timer. Disconnect counts are
captured at removal with the existing observer-session generation so rapid reconnects cannot erase the zero
edge or dismiss a replacement. No state persists across process restart.

Idle means no interaction or accepted show. The device fallback TTL is five minutes (300,000 ms), settable
locally on the controller. Shows (including same-id) and user interactions restart it (initial or restored
unchanged pager reports do not); configuration changes and safety hide/restore do not, and hidden
prototypes still expire. The strict protocol has no TTL or session-release message, so session release is
covered only when it closes the last WebSocket.

Rotation, density/size changes and fold posture callbacks refresh layout params
without recreating runtime or composition: authored state and settled pager pages
survive with no event or sequence allocation. If the owning display disappears,
dismiss rather than moving content onto another display; it never revives on return.
The service's default display is used; display selection is #9308.

Show-time keyguard/screen checks fail closed. Screen and window signals hide the
window while locked or noninteractive and restore the same runtime on unlock;
no dismissal event is emitted for temporary hiding. Own-package accessibility
events are dropped before hierarchy debouncing and navigation tracking.

## Foreground scoping (#10261)

A session prototype is tied to the app (package) it was shown over, matching the iOS agent, which lives inside the app. When that app leaves the foreground the window is hidden (state, pages and the idle TTL are kept; no `dismissed` event, no sequence allocation) and when the app returns the same runtime is shown again. A `window.persistence: "device"` prototype is a standalone mock and is not tied to an app.

- **Anchor.** Each `show` (including an in-place replace) reads the application window in front (the active application-type accessibility window, else the topmost) and clears any suspension. If none qualifies the prototype is unscoped and stays up everywhere.
- **Signal.** `TYPE_WINDOW_STATE_CHANGED` events already delivered to CtrlProxy; no new poller. An event moves the foreground only when its window is `TYPE_APPLICATION` and its package is not CtrlProxy's own and not in the ignore set, so IME, system dialogs, this prototype's own overlays and the shade are never candidates. Ignore set: `com.android.systemui`, `com.google.android.permissioncontroller`, `com.android.permissioncontroller`, `com.google.android.packageinstaller`, `com.android.packageinstaller`, `android` (resolver, ANR and crash dialogs). A dialog of the same app is the same package. An event whose window type cannot be read is ignored (fails open: nothing hides).
- **Debounce.** A flip either way applies only after the new state holds 400 ms (`PROTOTYPE_FOREGROUND_DEBOUNCE_MILLIS`).
- **Hidden means gone.** The window is removed: no touches, absent from `observe`. `inspect` reports `suspended: true` on the entry and the hierarchy capture carries top-level `prototypeSuspended: true`, so `layer: "prototype"` calls fail with "hidden because the app it was shown over is not in front" rather than "no prototype is showing". `inspect` also reports optional `hiddenReason`: `app_layer_window_hidden` when the app in front hides an app-layer window, or `device_blocked` when locked or screen off; the host carries it into status and `prototype_hidden` layer refusals. A show reports `visible: false` with the same `notVisibleReason`; older devices retain `no_prototype_window_on_screen`. Hidden reasons are absent when visible or suspended.
- **Host side.** The host stores `suspended` from `inspect` and surfaces it on `prototype` status entries (as fresh as the last `inspect`; a new `show` or an `inspect` after the app returns clears it); an `awaitEvent` that times out on a suspended prototype carries the same explanation as a `warning`. Absent on iOS.
- **Separate from other hides.** Suspension is its own state (`PrototypeForegroundTracker.suspended`). The host's `isBlocked` is the lock-screen check OR suspension, so any restore path that calls `show` while suspended is refused, and ending suspension does not undo a capture hide held by another component.
- Dismissal, TTL expiry and teardown release the anchor; a hidden prototype still expires on its idle TTL.

Secure windows are not detected: no trusted signal exists.

## Bottom sheet and the keyboard (#10262)

A bottom sheet moves above the keyboard whenever it is shown and returns to the screen edge when it hides.

- **Scope.** Only a `sheet` window with `edge: "bottom"`; fullscreen, floating, dialog, top and side sheets never move. A `bottomSheet` node rides with its window and needs no handling.
- **Source.** The input-method window's bounds from the accessibility window list (`TYPE_INPUT_METHOD`), not the prototype window's `WindowInsets.Type.ime()`: prototype windows are `TYPE_ACCESSIBILITY_OVERLAY` and not the IME target, and the platform dispatches the IME inset only to the target, so a sheet over another app's field would read 0. Lift is `screenBottom - ime.top` (0 when no input-method window has bounds).
- **Mechanism.** The host relayouts on the `TYPE_WINDOWS_CHANGED` events it already receives, setting the bottom-gravity window's `y` to the lift. Moving the window moves its touch region; touch-through and the foreground-suspension and capture hides act on the same params and `isBlocked`.
- **No system panning.** A bottom sheet sets `SOFT_INPUT_ADJUST_NOTHING`, so the platform does not also resize or pan it.
- **Motion.** The position jumps: the accessibility source reports no per-frame values (`WindowInsetsAnimation` only reaches the IME target), so `motion: "none"` has nothing to disable.
- **Explicit padding.** `safeAreaPadding` with `ime` still applies inside the window; on a lifted sheet it reads 0 for a non-IME-target window, so it does not double-count.

Android only. The iOS agent does not lift a sheet above the keyboard; whether to rely on UIKit keyboard avoidance or match this is an open decision (see [iOS prototype agent decisions](../../../devlog/2026-10-09-prototype-agent-ios-decisions.md)).
