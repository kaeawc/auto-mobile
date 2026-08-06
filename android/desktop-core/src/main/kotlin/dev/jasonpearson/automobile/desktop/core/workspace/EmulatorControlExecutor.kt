package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Runs a device-mutating emulator control (Rotate, Snapshot, Unlock) against a real device. This is
 * the seam #4694 wires: the [WorkspaceViewModel] resolves the target column and invokes this off
 * the UI thread, exactly as the picker's [DevicePickerViewModel] drives its `McpResourceClient`.
 * The real implementation is untested IO (see [DaemonEmulatorControlExecutor]); behavior is pinned
 * at the ViewModel boundary with [FakeEmulatorControlExecutor].
 *
 * Screenshot is intentionally NOT a device mutation here — it captures and surfaces a PNG in the
 * pane via the observation stream, so it is handled UI-side rather than through this
 * fire-and-forget seam.
 */
interface EmulatorControlExecutor {
  /**
   * Run [control] against [deviceId] on [platform]. [orientation] is the target orientation, used
   * only by [EmulatorControl.Rotate]. Suspends until the device call completes (or throws).
   */
  suspend fun run(
    deviceId: String,
    platform: Platform,
    control: EmulatorControl,
    orientation: Orientation,
  )
}

/** No-op seam for hosts/tests that don't wire real device execution. */
object NoOpEmulatorControlExecutor : EmulatorControlExecutor {
  override suspend fun run(
    deviceId: String,
    platform: Platform,
    control: EmulatorControl,
    orientation: Orientation,
  ) = Unit
}

/**
 * Real executor backed by the daemon [AutoMobileClient]. Sets the active device first, then invokes
 * the control's MCP tool with the resolved platform + deviceId, enabling the tool's server
 * capability where one gates it. Untested IO seam (mirrors `DaemonMcpResourceClient`).
 */
class DaemonEmulatorControlExecutor(
  private val client: AutoMobileClient,
  private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : EmulatorControlExecutor {
  override suspend fun run(
    deviceId: String,
    platform: Platform,
    control: EmulatorControl,
    orientation: Orientation,
  ) {
    withContext(ioDispatcher) {
      val wire = platform.wireName()
      // Target the pane's device explicitly (belt-and-suspenders with the deviceId arg below), so a
      // control never races onto whichever device happened to be active.
      client.setActiveDevice(deviceId, wire)
      when (control) {
        EmulatorControl.Rotate -> {
          // `rotate` lives behind the advanced-interaction capability.
          client.enableToolCapability("advanced-interaction")
          client.callTool(
            "rotate",
            buildJsonObject {
              put("orientation", orientation.toolValue)
              put("platform", wire)
              put("deviceId", deviceId)
            },
          )
        }
        EmulatorControl.Snapshot -> {
          // `deviceSnapshot` lives behind the screen-artifacts capability.
          client.enableToolCapability("screen-artifacts")
          client.callTool(
            "deviceSnapshot",
            buildJsonObject {
              put("action", "capture")
              put("platform", wire)
              put("deviceId", deviceId)
            },
          )
        }
        EmulatorControl.Unlock ->
          client.callTool(
            "wakeAndUnlock",
            buildJsonObject {
              put("platform", wire)
              put("deviceId", deviceId)
            },
          )
        // Handled UI-side via the observation stream, not as a fire-and-forget device call.
        EmulatorControl.Screenshot -> Unit
      }
    }
  }
}

/** Records requests for tests; optionally throws to exercise the ViewModel's failure handling. */
class FakeEmulatorControlExecutor : EmulatorControlExecutor {
  data class Request(
    val deviceId: String,
    val platform: Platform,
    val control: EmulatorControl,
    val orientation: Orientation,
  )

  val requests: MutableList<Request> = mutableListOf()
  var error: Throwable? = null

  override suspend fun run(
    deviceId: String,
    platform: Platform,
    control: EmulatorControl,
    orientation: Orientation,
  ) {
    error?.let { throw it }
    requests += Request(deviceId, platform, control, orientation)
  }
}
