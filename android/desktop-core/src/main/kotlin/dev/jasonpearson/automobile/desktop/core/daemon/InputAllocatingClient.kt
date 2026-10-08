package dev.jasonpearson.automobile.desktop.core.daemon

/** The error an input dropped by [InputAllocatingClient] reports. */
internal const val INPUT_NOT_ALLOCATED_ERROR =
  "Input dropped: the desktop session could not take control of this device. Another session " +
    "may hold it; use Take control to try again."

/**
 * Routes a pane's input through [allocation] first (#10730): the desktop session allocates the
 * target device on the first input, and an input it cannot allocate the device for is dropped
 * instead of reaching the daemon. Every other call goes straight to [delegate].
 *
 * The input methods block on the allocation, so they must run where the delegate's blocking socket
 * calls already run: the pane's dispatch thread or an IO dispatcher, never the UI thread.
 */
class InputAllocatingClient(
  private val delegate: AutoMobileClient,
  private val allocation: DesktopInputAllocation,
) : AutoMobileClient by delegate {

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
