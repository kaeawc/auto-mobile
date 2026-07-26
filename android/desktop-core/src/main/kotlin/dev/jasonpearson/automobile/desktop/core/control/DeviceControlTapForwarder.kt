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
 * The class is deliberately Compose-free and stateless so it can be unit tested against
 * [dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient] (or a real
 * [dev.jasonpearson.automobile.desktop.core.daemon.McpDaemonClient] over a socket) without
 * rendering a device or opening a real daemon connection.
 *
 * The tap target — client, platform, and device id — is passed in per call rather than resolved
 * lazily, so the caller can **snapshot** all of {coordinate, client, platform, deviceId} atomically
 * at click time on the UI thread. This matters because [forward] is expected to run off the UI
 * thread (e.g. a `Dispatchers.IO` coroutine, matching the existing daemon-action pattern in
 * `McpProcessesPanel`): if the active device changed between the click and the coroutine running,
 * resolving the target late would send the clicked coordinate to the wrong device.
 *
 * Its only consumer is `AutoMobileContent`; it is a deliberate testability seam extracted from that
 * Compose host so this logic is Compose-free and unit-testable per the repo's fakes/fast-tests
 * rule. Do not inline it — the unit tests below would be impossible to write against the
 * composable.
 */
class DeviceControlTapForwarder {

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
  fun forward(
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

    val result =
      try {
        client.inputTap(
          x = point.x.toDouble(),
          y = point.y.toDouble(),
          platform = platform,
          deviceId = deviceId,
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
