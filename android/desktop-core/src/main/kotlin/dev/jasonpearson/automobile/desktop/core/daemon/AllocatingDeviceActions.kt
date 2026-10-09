package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * A provider for the clients behind device-acting dashboard controls (#10831): device snapshots,
 * video recording and storage SQL. Each client is an [InputAllocatingClient], so a tool call that
 * names a device first allocates it to the desktop session ([allocation]) and then runs as that
 * session ([sessionUuidProvider]), exactly as a pane's input does (#10730). Reads (resources, and
 * tool calls that name no device) pass straight through, so watching still never takes a device.
 *
 * Null when there is no [clientProvider], like the dashboards' own Fake-mode null.
 */
fun allocatingClientProvider(
  clientProvider: (() -> AutoMobileClient)?,
  allocation: () -> DesktopInputAllocation,
  sessionUuidProvider: () -> String?,
): (() -> AutoMobileClient)? = clientProvider?.let { provider ->
  { InputAllocatingClient(provider(), allocation(), sessionUuidProvider) }
}

/**
 * Appearance changes act on devices: the daemon applies them only to devices the caller's session
 * holds, and refuses a session that holds none (#10831). Before a change, the selected device
 * ([activeDeviceId]) is allocated to the desktop session the same way input is, so the change
 * reaches it; with no selected device the change goes straight to the daemon. Reading the config
 * never allocates.
 */
class AllocatingAppearanceClient(
  private val delegate: AppearanceClient,
  private val allocation: () -> DesktopInputAllocation,
  private val activeDeviceId: () -> String?,
) : AppearanceClient by delegate {

  override fun setSyncWithHost(enabled: Boolean): AppearanceResult = allocated {
    delegate.setSyncWithHost(enabled)
  }

  override fun setMode(mode: AppearanceSyncMode): AppearanceResult = allocated {
    delegate.setMode(mode)
  }

  /** Blocks on the allocation: call it off the UI thread, as the dashboard does. */
  private inline fun allocated(change: () -> AppearanceResult): AppearanceResult {
    val deviceId = activeDeviceId()
    if (deviceId != null && !allocation().awaitInputAllowed(deviceId)) {
      throw McpConnectionException(INPUT_NOT_ALLOCATED_ERROR)
    }
    return change()
  }
}

/**
 * Arguments for the Take Screenshot action (#10831): there is no `screenshot` tool, so it runs
 * `observe`, which captures and saves the screen of [deviceId]. Naming the device makes it a
 * device-acting call on an [allocatingClientProvider] client.
 */
fun screenshotObserveArguments(deviceId: String, platform: String): JsonObject = buildJsonObject {
  put("platform", platform)
  put("deviceId", deviceId)
}
