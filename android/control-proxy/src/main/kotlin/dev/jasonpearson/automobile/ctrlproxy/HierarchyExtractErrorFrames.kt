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
    if (uuid.isNullOrBlank()) null else CorrelatedErrorReporter.frame(uuid, NULL_HIERARCHY_ERROR)

  /**
   * The correlated error frame to broadcast when `extractHierarchy` throws [error]. Returns `null`
   * for a [CancellationException] (the caller must rethrow it so cooperative cancellation unwinds)
   * or for a blank/absent [uuid] (no id to correlate a frame to). The error string mirrors the
   * production message, carrying the throwable's `message` (falling back to its simple class name).
   */
  fun thrownFrame(uuid: String?, error: Throwable): ErrorResponse? {
    if (error is CancellationException) return null
    if (uuid.isNullOrBlank()) return null
    return CorrelatedErrorReporter.frame(
      requestId = uuid,
      errorMessage = THROWN_PREFIX + CorrelatedErrorReporter.causeOf(error),
    )
  }
}

/**
 * Emits the correlated WebSocket `type:"error"` frame for a failed `EXTRACT_HIERARCHY` broadcast,
 * keyed by the broadcast's `sync_` `requestId` uuid. A null frame (blank/absent uuid, or a
 * cancellation the caller rethrows — see [HierarchyExtractErrorFrames]) is a no-op.
 *
 * The daemon's ADB-broadcast hierarchy fallback awaits that uuid in `waitForFreshData` over this
 * same WebSocket (the response channel the success-path `hierarchy_update` push also travels on).
 * Before issue #3089 a broadcast-handler failure only sent an ADB `OPERATION_RESULT` that the
 * daemon's wait could not correlate, so it degraded to a full timeout. Emitting this frame closes
 * that last member of the #3032/#3061 `waitForFreshData` hang class, mirroring the WebSocket
 * `req_`/`stale_` paths and the #2985 decode/handler error envelope.
 *
 * Routed through [ResultBroadcaster.guard] so a throw while *sending* this frame degrades to the
 * daemon's timeout rather than escaping the receiver coroutine (issue #3045 / #3085).
 */
internal class HierarchyExtractFrameSender(
  private val transport: Transport,
  private val resultBroadcaster: ResultBroadcaster,
) {
  /** The late-bound WebSocket server. */
  interface Transport {
    fun isRunning(): Boolean

    /**
     * For an id minted outside the socket server (an ADB broadcast), which owns no route for it.
     */
    suspend fun broadcastExternallyCorrelated(frame: ErrorResponse)

    suspend fun broadcast(frame: ErrorResponse)
  }

  suspend fun send(frame: ErrorResponse?, externallyCorrelated: Boolean = true) {
    // A null frame means there was nothing to correlate (blank/absent uuid, or a cooperative
    // cancellation that must propagate); HierarchyExtractErrorFrames already made that decision, so
    // there is no WebSocket frame to send here. See issue #3131.
    if (frame == null) return
    resultBroadcaster.guard(frame.requestId, "hierarchy_extract_error") {
      if (transport.isRunning()) {
        if (externallyCorrelated) transport.broadcastExternallyCorrelated(frame)
        else transport.broadcast(frame)
      }
    }
  }
}
