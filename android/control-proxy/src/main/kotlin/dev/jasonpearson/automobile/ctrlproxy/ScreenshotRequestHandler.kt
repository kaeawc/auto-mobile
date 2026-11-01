package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeHiddenCapture
import dev.jasonpearson.automobile.protocol.ScreenshotResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse

/** Answers a `request_screenshot` with a `screenshot` result or a correlated `screenshot_error`. */
internal class ScreenshotRequestHandler(
  private val host: Host,
  private val asyncActionRunner: AsyncActionRunner,
  private val timeProvider: TimeProvider,
) {
  /** The service members a screenshot request needs. */
  interface Host {
    fun isRunning(): Boolean

    fun connectionCount(): Int

    suspend fun broadcast(response: WebSocketResponse)

    suspend fun broadcast(frame: String)

    /** The staleness token; a capture is tagged with it only if it did not change meanwhile. */
    fun currentFrameContext(): String

    fun activeDisplayId(): Int

    fun panelUniqueId(displayId: Int): String?

    suspend fun capture(displayId: Int): ScreenshotCaptureOutcome

    /** Hide the prototype, capture, and restore it, all on the device (#9305). */
    suspend fun captureWithPrototypeHidden(
      displayId: Int,
    ): PrototypeHiddenCapture<ScreenshotCaptureOutcome>
  }

  fun broadcastScreenshot(requestId: String?, displayId: Int?, hidePrototypes: Boolean) {
    if (!host.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping screenshot broadcast")
      return
    }

    // Routed through asyncActionRunner: a throw in the capture (or the broadcast) would otherwise
    // be logged-and-swallowed, emitting neither `screenshot` nor `screenshot_error` and hanging the
    // awaiting client until timeout (issue #3023).
    asyncActionRunner.launch(requestId, "screenshot") {
      val contextBeforeCapture = host.currentFrameContext()
      val targetDisplayId = displayId ?: host.activeDisplayId()
      val prototypesHidden: Boolean?
      val outcome =
        if (hidePrototypes) {
          val capture = host.captureWithPrototypeHidden(targetDisplayId)
          prototypesHidden = capture.prototypeExcluded
          capture.value
        } else {
          prototypesHidden = null
          host.capture(targetDisplayId)
        }
      val stableContext = contextBeforeCapture.takeIf { it == host.currentFrameContext() }
      when (outcome) {
        is ScreenshotCaptureOutcome.Success -> {
          val screenshot = outcome.payload
          host.broadcast(
            ScreenshotResult(
              timestamp = timeProvider.currentTimeMillis(),
              requestId = requestId,
              data = screenshot.base64Image,
              format = "jpeg",
              rotation = screenshot.rotation,
              displayId = screenshot.displayId,
              panelUniqueId = screenshot.panelUniqueId,
              screenshotCaptureDurationMs = screenshot.captureDurationMs,
              screenshotEncodeDurationMs = screenshot.encodeDurationMs,
              screenshotByteLength = screenshot.byteLength,
              screenshotBase64Length = screenshot.base64Length,
              frameContext = stableContext,
              prototypesHidden = prototypesHidden,
            ),
          )
          Log.d(TAG, "Broadcasted screenshot to ${host.connectionCount()} clients")
        }
        is ScreenshotCaptureOutcome.Failure -> {
          // Surface a rate limit distinctly so the daemon classifies it as ctrlproxy_rate_limited
          // rather than a generic capture failure (issue #4927).
          val error = CtrlProxyScreenshotWire.errorMessageForCode(outcome.errorCode)
          host.broadcast(
            screenshotErrorFrame(
              requestId,
              error,
              targetDisplayId,
              host.panelUniqueId(targetDisplayId),
            ),
          )
        }
      }
    }
  }

  private companion object {
    const val TAG = "CtrlProxy"
  }
}
