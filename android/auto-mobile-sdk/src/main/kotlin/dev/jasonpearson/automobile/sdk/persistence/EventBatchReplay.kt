package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.SdkEvent
import java.util.concurrent.atomic.AtomicBoolean

internal const val MAX_REPLAY_BATCHES_PER_LAUNCH = 20

/**
 * Start on a background executor, then chain FIFO replay through background completion hops. A
 * refused hop or a delivery that never completes leaves the remaining files for next launch.
 */
internal fun replayEventBatches(
  persistence: EventPersistence,
  runInBackground: (Runnable) -> Unit,
  deliver: (List<SdkEvent>, (Boolean) -> Unit) -> Unit,
) {
  val pending =
    try {
      persistence.loadPending().take(MAX_REPLAY_BATCHES_PER_LAUNCH)
    } catch (_: Exception) {
      // Custom persistence may fail to read; leave its files for the next launch.
      return
    }

  fun submit(index: Int) {
    if (index >= pending.size) return
    val (batchId, events) = pending[index]
    val completed = AtomicBoolean(false)
    val complete: (Boolean) -> Unit = { delivered ->
      if (completed.compareAndSet(false, true)) {
        try {
          runInBackground(
            Runnable {
              try {
                if (delivered) persistence.removeBatch(batchId)
                else persistence.recordReplayFailure(batchId)
              } catch (_: Exception) {
                // A custom persistence failure leaves the batch on disk for the next launch.
              }
              submit(index + 1)
            }
          )
        } catch (_: Exception) {
          // Shutdown can refuse the hop. Never do disk I/O on this completion thread.
        }
      }
    }
    try {
      deliver(events, complete)
    } catch (_: Exception) {
      // A throwing delivery also consumes a replay attempt, without persisting a duplicate.
      complete(false)
    }
  }
  submit(0)
}
