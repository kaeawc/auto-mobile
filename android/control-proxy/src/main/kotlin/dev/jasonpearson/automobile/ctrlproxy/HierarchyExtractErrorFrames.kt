package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.ErrorResponse
import kotlinx.coroutines.CancellationException

/**
 * Pure failure-decision + frame-construction for the `ACTION_EXTRACT_HIERARCHY` branch of
 * [CtrlProxy.handleCommand] (PR #3126, issue #3089). Isolated as an Android-free helper — mirroring
 * how [BroadcastGuardScanner]/[LaunchCancellationScanner] factor out testable logic — so the
 * correlated-error-frame contract can be unit-tested behaviorally without a Robolectric
 * `AccessibilityService` harness (issue #3131).
 *
 * The daemon's ADB-broadcast hierarchy fallback awaits the request `uuid` over the WebSocket in
 * `waitForFreshData`. On extraction failure the runner must emit a correlated
 * [ErrorResponse]`(requestId = uuid)` so that wait fails fast instead of hanging to timeout; a
 * cooperative [CancellationException] must instead propagate untouched so the coroutine unwinds
 * cleanly. This object encodes exactly that mapping; [CtrlProxy.handleCommand] applies its result
 * to the (guarded) WebSocket sink.
 */
object HierarchyExtractErrorFrames {

  /** Error string emitted when `extractHierarchy` returns a null hierarchy. */
  const val NULL_HIERARCHY_ERROR = "Failed to extract hierarchy"

  /** Prefix for the error string emitted when `extractHierarchy` throws. */
  const val THROWN_PREFIX = "Hierarchy extraction failed: "

  /**
   * The correlated error frame to broadcast when `extractHierarchy` returns `null`, or `null` when
   * the request carried no `uuid` to correlate against (only the legacy ADB result is sent then, so
   * no WebSocket frame is produced).
   */
  fun nullResultFrame(uuid: String?): ErrorResponse? =
    if (uuid.isNullOrBlank()) null
    else ErrorResponse(requestId = uuid, error = NULL_HIERARCHY_ERROR)

  /**
   * The correlated error frame to broadcast when `extractHierarchy` throws [error]. Returns `null`
   * for a [CancellationException] (the caller must rethrow it so cooperative cancellation unwinds)
   * or for a blank/absent [uuid] (no id to correlate a frame to). The error string mirrors the
   * production message, carrying the throwable's `message` (falling back to its simple class name).
   */
  fun thrownFrame(uuid: String?, error: Throwable): ErrorResponse? {
    if (error is CancellationException) return null
    if (uuid.isNullOrBlank()) return null
    val cause = error.message ?: error::class.simpleName ?: "unknown error"
    return ErrorResponse(requestId = uuid, error = THROWN_PREFIX + cause)
  }
}
