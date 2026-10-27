package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal class McpDaemonInputOperations(private val owner: () -> McpDaemonClient) :
  AutoMobileInputOperations {
  override fun inputTap(input: TapInput): InputActionResult {
    with(owner()) {
      val x = input.x
      val y = input.y
      val platform = input.platform
      val deviceId = input.deviceId
      val duration = input.duration
      val frameContext = input.frameContext

      return sendInputRequest(
        "input/tap",
        buildJsonObject {
          put("platform", JsonPrimitive(platform))
          putOptionalString("deviceId", deviceId)
          put("x", JsonPrimitive(x))
          put("y", JsonPrimitive(y))
          putOptionalInt("duration", duration)
          putOptionalString("frameContext", frameContext)
        },
      )
    }
  }

  override fun inputSwipe(input: SwipeInput): InputActionResult {
    with(owner()) {
      val startX = input.startX
      val startY = input.startY
      val endX = input.endX
      val endY = input.endY
      val platform = input.platform
      val deviceId = input.deviceId
      val durationMs = input.durationMs
      val frameContext = input.frameContext

      return sendInputRequest(
        "input/swipe",
        buildJsonObject {
          put("platform", JsonPrimitive(platform))
          putOptionalString("deviceId", deviceId)
          put("startX", JsonPrimitive(startX))
          put("startY", JsonPrimitive(startY))
          put("endX", JsonPrimitive(endX))
          put("endY", JsonPrimitive(endY))
          putOptionalInt("durationMs", durationMs)
          putOptionalString("frameContext", frameContext)
        },
      )
    }
  }

  override fun inputPressButton(
    button: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult {
    with(owner()) {
      return sendInputRequest(
        "input/pressButton",
        buildJsonObject {
          put("platform", JsonPrimitive(platform))
          putOptionalString("deviceId", deviceId)
          put("button", JsonPrimitive(button))
          putOptionalString("frameContext", frameContext)
        },
      )
    }
  }

  override fun inputTypeText(input: TextInput): InputActionResult {
    with(owner()) {
      val text = input.text
      val platform = input.platform
      val deviceId = input.deviceId
      val submit = input.submit
      val append = input.append
      val frameContext = input.frameContext

      val appendSupportError = if (append) inputTypeTextAppendSupportError() else null
      if (appendSupportError != null) {
        return InputActionResult(
          action = "input/typeText",
          success = false,
          error = appendSupportError,
        )
      }
      var completed = false
      return try {
        sendInputRequest(
            "input/typeText",
            buildJsonObject {
              put("platform", JsonPrimitive(platform))
              putOptionalString("deviceId", deviceId)
              put("text", JsonPrimitive(text))
              putOptionalBoolean("submit", submit)
              putOptionalString("frameContext", frameContext)
              // Omitted entirely when false: the daemon rejects unknown/!append values, and older
              // daemons reject the param outright.
              if (append) put("mode", JsonPrimitive("append"))
            },
          )
          .let { result ->
            if (append && result.error == OLD_DAEMON_APPEND_MODE_ERROR) {
              evictDaemonCapabilities()
              result.copy(error = UNSUPPORTED_APPEND_MODE_ERROR)
            } else {
              result
            }
          }
          .also { completed = true }
      } finally {
        if (append && !completed) evictDaemonCapabilities()
      }
    }
  }

  override fun inputKey(
    key: String,
    platform: String,
    deviceId: String?,
    frameContext: String?,
  ): InputActionResult {
    with(owner()) {
      return sendInputRequest(
        "input/key",
        buildJsonObject {
          put("platform", JsonPrimitive(platform))
          putOptionalString("deviceId", deviceId)
          put("key", JsonPrimitive(key))
          putOptionalString("frameContext", frameContext)
        },
      )
    }
  }

  override fun openGestureStream(platform: String, deviceId: String?): GestureInputStream? {
    with(owner()) {

      // Streaming has no XCUITest equivalent, and only this Unix-socket transport can hold a
      // connection open. Everything else falls back to the atomic swipe (the interface default).
      if (platform != "android") return null
      if (!daemonSupportsGestureStream()) return null
      return try {
        McpGestureInputStream(owner(), platform, deviceId, connectPersistentChannel())
      } catch (error: java.io.IOException) {
        DAEMON_PATHS_LOG.debug("Daemon openGestureStream failed: ${error.message}")

        // Could not establish the persistent connection; the caller falls back to inputSwipe.
        null
      } catch (error: McpConnectionException) {
        DAEMON_PATHS_LOG.debug("Daemon openGestureStream failed: ${error.message}")

        // Could not establish the persistent connection; the caller falls back to inputSwipe.
        null
      } catch (error: IllegalArgumentException) {
        DAEMON_PATHS_LOG.debug("Daemon openGestureStream failed: ${error.message}")

        // Could not establish the persistent connection; the caller falls back to inputSwipe.
        null
      }
    }
  }
}
