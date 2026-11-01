package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.FrameContextValidationResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.util.concurrent.atomic.AtomicLong

/**
 * The device-owned frame-context token that capture and input share. It changes immediately on a
 * native UI event, so an input mapped through a screen the service has since seen change can be
 * refused instead of landing on the wrong UI.
 */
internal class FrameContextGate(
  /** Fresh for every service process, so a restarted runner cannot reuse an old token. */
  private val epoch: String,
  private val asyncActionRunner: AsyncActionRunner,
  private val timeProvider: TimeProvider,
  private val broadcast: suspend (WebSocketResponse) -> Unit,
) {
  private val counter = AtomicLong(0)

  fun current(): String = "$epoch:${counter.get()}"

  /** Called for every UI-changing event, whether or not anyone is observing. */
  fun advance() {
    counter.incrementAndGet()
  }

  /** True when [expected] names a frame other than the current one; null means "unchecked". */
  fun isStale(expected: String?): Boolean = expected != null && expected != current()

  /** Answers a key-input staleness check with a correlated `frame_context_validation` result. */
  fun validate(requestId: String?, frameContext: String) {
    val matches = frameContext == current()
    asyncActionRunner.launch(requestId, "validate_frame_context") {
      broadcast(
        FrameContextValidationResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = matches,
          totalTimeMs = 0,
          error =
            if (matches) {
              null
            } else {
              "Stale frame context for input/key; observe a fresh frame before retrying"
            },
        ),
      )
    }
  }
}
