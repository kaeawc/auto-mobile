package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint

/**
 * Forwards a device-control tap (a [DevicePoint] produced by
 * [dev.jasonpearson.automobile.desktop.domain.DeviceScreenCoordinateMapper] in
 * [dev.jasonpearson.automobile.desktop.domain.DeviceScreenControlMode.Control]) to the typed daemon
 * `input/tap` helper. This is the client-side glue for issue #3347: the device-screen view only
 * maps a click to a coordinate and reports it; wiring that coordinate to the daemon is this class's
 * job.
 *
 * The class is deliberately Compose-free and synchronous so it can be unit tested against
 * [dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient] (or a real
 * [dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient] over a socket) without
 * rendering a device or opening a real daemon connection. The caller is responsible for running
 * [forward] off the UI thread (e.g. a `Dispatchers.IO` coroutine), matching the existing
 * daemon-action pattern in `McpProcessesPanel`.
 *
 * Collaborators are supplied as providers because the connected client, active platform, and active
 * device id can all change between taps in the reference desktop client; each tap resolves the
 * latest value.
 *
 * @param clientProvider resolves the daemon client for the connected process, or null when nothing
 *   is connected (no daemon input is sent in that case).
 * @param platformProvider the daemon platform string for the active device ("android" / "ios").
 * @param deviceIdProvider the active device id, or null to let the daemon pick its active device.
 * @param onError invoked with the daemon's actionable error message (or an exception message) when
 *   a tap fails, so the UI can surface it. Never called for an out-of-bounds point (that is dropped
 *   silently) or a successful tap.
 */
class DeviceControlTapForwarder(
  private val clientProvider: () -> AutoMobileClient?,
  private val platformProvider: () -> String,
  private val deviceIdProvider: () -> String?,
  private val onError: (String) -> Unit,
) {

  /**
   * Send [point] to the daemon as a tap. Out-of-bounds points (see [DevicePoint.inBounds]) are
   * dropped without contacting the daemon, per the coordinate-mapping contract — a control client
   * must never tap an off-screen coordinate. A daemon failure or a thrown client exception is
   * routed to [onError] instead of propagating, so a failed tap can never crash the UI.
   */
  fun forward(point: DevicePoint) {
    // Out of bounds: the mapping never clamps, so a click outside the device screen produces an
    // off-screen coordinate. Dropping it honors the screen-control-mapping contract (the daemon
    // must not receive an off-screen tap).
    if (!point.inBounds) return

    val client = clientProvider() ?: return

    val result =
      try {
        client.inputTap(
          x = point.x.toDouble(),
          y = point.y.toDouble(),
          platform = platformProvider(),
          deviceId = deviceIdProvider(),
        )
      } catch (error: Exception) {
        // A transport/client failure must surface, not crash the UI. Reuse the client's own
        // message.
        onError(error.message ?: DEFAULT_TAP_ERROR)
        return
      }

    if (!result.success) {
      // The daemon rejected the tap; surface its actionable error verbatim rather than inventing a
      // generic message. Error semantics come from the daemon response (InputActionResult.error).
      onError(result.error ?: DEFAULT_TAP_ERROR)
    }
  }

  companion object {
    /** Fallback shown only when the daemon/client failure carries no message of its own. */
    const val DEFAULT_TAP_ERROR: String = "Failed to send tap to the device"
  }
}
