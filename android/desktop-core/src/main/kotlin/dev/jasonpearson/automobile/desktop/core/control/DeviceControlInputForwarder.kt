package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.domain.DevicePoint

/**
 * Forwards a device-control input (points produced by
 * [dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper] in
 * [dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode.Control]) to the typed daemon
 * `input/tap` and `input/swipe` helpers. This is the client-side glue for issues #3347 and #3350:
 * the device-screen view only maps a gesture to coordinates and reports them; wiring those
 * coordinates to the daemon is this class's job.
 *
 * The class is deliberately Compose-free and stateless so it can be unit tested against
 * [dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient] (or a real
 * [dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient] over a socket) without
 * rendering a device or opening a real daemon connection.
 *
 * The input target — client, platform, and device id — is passed in per call rather than resolved
 * lazily, so the caller can **snapshot** all of {coordinates, client, platform, deviceId}
 * atomically at gesture time on the UI thread. This matters because these methods are expected to
 * run off the UI thread (e.g. a `Dispatchers.IO` coroutine, matching the existing daemon-action
 * pattern in `McpProcessesPanel`): if the active device changed between the gesture and the
 * coroutine running, resolving the target late would send the gesture to the wrong device.
 *
 * Its only consumer is `DeviceControlSession`; it is a deliberate testability seam extracted from
 * that session so this logic is Compose-free and unit-testable per the repo's fakes/fast-tests
 * rule. Do not inline it — the unit tests below would be impossible to write against the
 * composable.
 */
class DeviceControlInputForwarder {

  /**
   * Send [point] to [client] as a tap at the given [platform] / [deviceId]. Out-of-bounds points
   * (see [DevicePoint.inBounds]) are dropped without contacting the daemon, per the
   * coordinate-mapping contract — a control client must never tap an off-screen coordinate. A null
   * [client] (nothing connected) is likewise dropped silently. A daemon failure or a thrown client
   * exception is routed to [onError] instead of propagating, so a failed tap can never crash the
   * UI.
   *
   * @param client the daemon client to tap through, snapshotted at click time; null drops the tap.
   * @param platform the daemon platform string for the tapped device ("android" / "ios").
   * @param deviceId the target device id, or null to let the daemon pick its active device.
   * @param onError invoked with the daemon's actionable error message (or an exception message)
   *   when the tap fails. Never called for an out-of-bounds point or a successful tap.
   */
  fun forwardTap(
    point: DevicePoint,
    client: AutoMobileClient?,
    platform: String,
    deviceId: String?,
    onError: (String) -> Unit,
  ) {
    // Out of bounds: the mapping never clamps, so a click outside the device screen produces an
    // off-screen coordinate. Dropping it honors the screen-control-mapping contract (the daemon
    // must not receive an off-screen tap).
    if (!point.inBounds) return

    // Nothing connected: drop silently rather than surfacing a spurious error.
    if (client == null) return

    forward(onError) {
      client.inputTap(
        x = point.x.toDouble(),
        y = point.y.toDouble(),
        platform = platform,
        deviceId = deviceId,
      )
    }
  }

  /**
   * Send a swipe from [start] to [end] over [durationMs] to [client].
   *
   * Both endpoints must already have been accepted by
   * [dev.jasonpearson.automobile.desktop.domain.DeviceDragGesturePolicy] — the threshold and
   * clamping rules live there, not here — but this method re-checks [DevicePoint.inBounds] on both
   * ends as the same last-resort guard [forwardTap] applies, so no path can put an off-screen
   * coordinate on the wire. A null [client] drops the swipe silently; a daemon failure or thrown
   * client exception is routed to [onError] rather than propagating.
   */
  fun forwardSwipe(
    start: DevicePoint,
    end: DevicePoint,
    durationMs: Int,
    client: AutoMobileClient?,
    platform: String,
    deviceId: String?,
    onError: (String) -> Unit,
  ) {
    // Either endpoint off-screen makes the whole gesture malformed: the daemon interpolates
    // between the two, so a bad end is as damaging as a bad start.
    if (!start.inBounds || !end.inBounds) return

    if (client == null) return

    forward(onError) {
      client.inputSwipe(
        startX = start.x.toDouble(),
        startY = start.y.toDouble(),
        endX = end.x.toDouble(),
        endY = end.y.toDouble(),
        platform = platform,
        deviceId = deviceId,
        durationMs = durationMs,
      )
    }
  }

  /**
   * Send a device/navigation button press to [client] via the typed `input/pressButton` helper
   * (issue #3351).
   *
   * [button] is already in the daemon's button vocabulary — the pure
   * [dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardInputPolicy] resolved the keystroke
   * before the command was enqueued, so no key mapping is re-derived here. A null [client] drops
   * the press silently; a daemon failure or thrown client exception is routed to [onError].
   */
  fun forwardPressButton(
    button: String,
    client: AutoMobileClient?,
    platform: String,
    deviceId: String?,
    onError: (String) -> Unit,
  ) {
    if (client == null) return
    forward(onError) {
      client.inputPressButton(button = button, platform = platform, deviceId = deviceId)
    }
  }

  /**
   * Send printable text to [client] via the typed `input/typeText` helper (issue #3351).
   *
   * Empty text is dropped without contacting the daemon: there is no such thing as typing nothing,
   * and forwarding it would start a post-input refresh wait for a device change that never happens
   * — the same reasoning that drops an out-of-bounds tap in [forwardTap].
   *
   * `submit` is deliberately not passed. Submitting is the Enter key's job, which travels this seam
   * as its own `input/key` command; folding it into the text call would make one keystroke's effect
   * depend on what was typed before it.
   */
  fun forwardTypeText(
    text: String,
    client: AutoMobileClient?,
    platform: String,
    deviceId: String?,
    onError: (String) -> Unit,
  ) {
    if (text.isEmpty()) return
    if (client == null) return
    forward(onError) {
      client.inputTypeText(text = text, platform = platform, deviceId = deviceId)
    }
  }

  /**
   * Send a discrete key event to [client] via the typed `input/key` helper (issue #3351).
   *
   * [key] is already in the daemon's key vocabulary. `input/key` is Android-only; on iOS the daemon
   * answers with an actionable error, which reaches [onError] like any other daemon rejection and
   * surfaces in the client's error banner rather than being swallowed.
   */
  fun forwardKey(
    key: String,
    client: AutoMobileClient?,
    platform: String,
    deviceId: String?,
    onError: (String) -> Unit,
  ) {
    if (client == null) return
    forward(onError) { client.inputKey(key = key, platform = platform, deviceId = deviceId) }
  }

  /**
   * Run one typed daemon input call, converting both a thrown client exception and a
   * daemon-reported failure into a single [onError] callback. Shared by every forward method so
   * they cannot drift in how they report failure.
   */
  private inline fun forward(
    onError: (String) -> Unit,
    call: () -> InputActionResult,
  ) {
    val result =
      try {
        call()
      } catch (error: Exception) {
        // A transport/client failure must surface, not crash the UI. Reuse the client's own
        // message.
        onError(error.message ?: DEFAULT_INPUT_ERROR)
        return
      }

    if (!result.success) {
      // The daemon rejected the input; surface its actionable error verbatim rather than inventing
      // a generic message. Error semantics come from the daemon response (InputActionResult.error).
      onError(result.error ?: DEFAULT_INPUT_ERROR)
    }
  }

  companion object {
    /** Fallback shown only when the daemon/client failure carries no message of its own. */
    const val DEFAULT_INPUT_ERROR: String = "Failed to send input to the device"
  }
}
