package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The error an input dropped by [InputAllocatingClient] reports. */
internal const val INPUT_NOT_ALLOCATED_ERROR =
  "Input dropped: the desktop session could not take control of this device. Another session " +
    "may hold it; use Take control to try again."

/**
 * Routes a pane's input through [allocation] first (#10730): the desktop session allocates the
 * target device on the first input, and an input it cannot allocate the device for is dropped
 * instead of reaching the daemon. Every other call goes straight to [delegate].
 *
 * A tool call that names a `deviceId` is input too: the desktop's device controls (rotate, device
 * snapshot, unlock, locale) drive the device, so they allocate it the same way and run as the
 * desktop session ([sessionUuidProvider]) that holds it, never under another session or an implicit
 * one. Only send tool calls through this client that act on the device; reads belong on a client
 * that does not allocate.
 *
 * The input methods block on the allocation, so they must run where the delegate's blocking socket
 * calls already run: the pane's dispatch thread or an IO dispatcher, never the UI thread.
 */
class InputAllocatingClient(
  private val delegate: AutoMobileClient,
  private val allocation: DesktopInputAllocation,
  /** The desktop session a device-targeted tool call acts as; null leaves the call unnamed. */
  private val sessionUuidProvider: () -> String? = { null },
) : AutoMobileClient by delegate {

  override fun callTool(name: String, arguments: JsonObject): JsonElement {
    val deviceId = (arguments["deviceId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    // A tool call without a device id targets no particular device, so there is nothing to
    // allocate. A read (observe, SELECT) only watches: it neither takes the device nor names a
    // session, and the daemon serves it sessionless (#10968).
    if (deviceId == null || isDeviceReadCall(name, arguments)) {
      return delegate.callTool(name, arguments)
    }
    if (!allocation.awaitInputAllowed(deviceId)) {
      throw McpConnectionException(INPUT_NOT_ALLOCATED_ERROR)
    }
    val session = sessionUuidProvider()
    val named =
      if (session.isNullOrBlank() || "sessionUuid" in arguments) {
        arguments
      } else {
        JsonObject(arguments + ("sessionUuid" to JsonPrimitive(session)))
      }
    return delegate.callTool(name, named)
  }

  // Interface delegation would send the default callToolChecked straight to the delegate's
  // callTool, skipping the allocation above.
  override fun callToolChecked(name: String, arguments: JsonObject): JsonElement =
    checkToolResponse(callTool(name, arguments), DaemonJson)

  override fun inputTap(
    x: Double,
    y: Double,
    platform: String,
    deviceId: String?,
    duration: Int?,
    frameContext: String?,
  ): InputActionResult =
    allocated("input/tap", platform, deviceId) {
      delegate.inputTap(x, y, platform, deviceId, duration, frameContext)
    }

  override fun inputSwipe(
    startX: Double,
    startY: Double,
    endX: Double,
    endY: Double,
    platform: String,
    deviceId: String?,
    durationMs: Int?,
    frameContext: String?,
  ): InputActionResult =
    allocated("input/swipe", platform, deviceId) {
      delegate.inputSwipe(startX, startY, endX, endY, platform, deviceId, durationMs, frameContext)
    }

  override fun inputPressButton(
    button: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult =
    allocated("input/pressButton", platform, deviceId) {
      delegate.inputPressButton(button, platform, deviceId, frameContext)
    }

  override fun inputTypeText(
    text: String,
    platform: String,
    deviceId: String?,
    submit: Boolean?,
    append: Boolean,
    frameContext: String?,
  ): InputActionResult =
    allocated("input/typeText", platform, deviceId) {
      delegate.inputTypeText(text, platform, deviceId, submit, append, frameContext)
    }

  override fun inputKey(
    key: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult =
    allocated("input/key", platform, deviceId) {
      delegate.inputKey(key, platform, deviceId, frameContext)
    }

  // Key-value edits are device mutations (#10827): claim the device for the desktop session, then
  // send as it. A refused claim reports a typed failure instead of reaching the daemon. The reads
  // (resources) never come through here, so they only watch.
  override fun setKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    value: String?,
    type: String,
    platform: String,
    sessionUuid: String?,
  ): SetKeyValueResult =
    if (!allocation.awaitInputAllowed(deviceId)) {
      SetKeyValueResult(success = false, message = INPUT_NOT_ALLOCATED_ERROR)
    } else {
      delegate.setKeyValue(
        deviceId,
        appId,
        fileName,
        key,
        value,
        type,
        platform,
        sessionUuid ?: sessionUuidProvider(),
      )
    }

  override fun removeKeyValue(
    deviceId: String,
    appId: String,
    fileName: String,
    key: String,
    platform: String,
    sessionUuid: String?,
  ): RemoveKeyValueResult =
    if (!allocation.awaitInputAllowed(deviceId)) {
      RemoveKeyValueResult(success = false, message = INPUT_NOT_ALLOCATED_ERROR)
    } else {
      delegate.removeKeyValue(
        deviceId,
        appId,
        fileName,
        key,
        platform,
        sessionUuid ?: sessionUuidProvider(),
      )
    }

  override fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String,
    sessionUuid: String?,
  ): ClearKeyValueResult =
    if (!allocation.awaitInputAllowed(deviceId)) {
      ClearKeyValueResult(success = false, message = INPUT_NOT_ALLOCATED_ERROR)
    } else {
      delegate.clearKeyValueFile(
        deviceId,
        appId,
        fileName,
        platform,
        sessionUuid ?: sessionUuidProvider(),
      )
    }

  /**
   * A refused allocation opens no stream; the caller then falls back to [inputSwipe], which is
   * refused the same way and reports [INPUT_NOT_ALLOCATED_ERROR].
   */
  override fun openGestureStream(platform: String, deviceId: String?): GestureInputStream? =
    if (deviceId == null || allocation.awaitInputAllowed(deviceId)) {
      delegate.openGestureStream(platform, deviceId)
    } else {
      null
    }

  private inline fun allocated(
    action: String,
    platform: String,
    deviceId: String?,
    send: () -> InputActionResult,
  ): InputActionResult =
    // An input without a device id targets no particular device, so there is nothing to allocate.
    if (deviceId == null || allocation.awaitInputAllowed(deviceId)) {
      send()
    } else {
      InputActionResult(
        action = action,
        success = false,
        platform = platform,
        deviceId = deviceId,
        error = INPUT_NOT_ALLOCATED_ERROR,
      )
    }
}
