package dev.jasonpearson.automobile.sdk.persistence

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.sdk.events.BatchDeliveryOutcome
import dev.jasonpearson.automobile.sdk.logging.DefaultSdkLogger
import java.util.concurrent.atomic.AtomicBoolean

internal const val MAX_REPLAY_BATCHES_PER_LAUNCH = 20

/** One guard spans both startup and flush-triggered replay, including asynchronous completions. */
internal class EventBatchReplay {
  private val running = AtomicBoolean(false)

  fun replay(
    persistence: EventPersistence,
    runInBackground: (Runnable) -> Unit,
    deliver: (List<SdkEvent>, (BatchDeliveryOutcome) -> Unit) -> Unit,
  ) {
    if (!running.compareAndSet(false, true)) return
    try {
      persistence.cleanup()
      var discardCurrent = false
      replayEventBatches(
        persistence,
        runInBackground,
        onComplete = { running.set(false) },
        discardOnFailure = { discardCurrent },
      ) { events, complete ->
        deliver(events) { outcome ->
          discardCurrent = outcome == BatchDeliveryOutcome.INVALID_PAYLOAD
          complete(outcome == BatchDeliveryOutcome.DELIVERED)
        }
      }
    } catch (error: Exception) {
      DefaultSdkLogger().w("EventBatchReplay", error) { "Could not prepare replay" }
      running.set(false)
    }
  }
}

/**
 * Start on a background executor, then chain FIFO replay through background completion hops. A
 * refused hop or the first undelivered batch leaves the remaining files for a later pass.
 */
internal fun replayEventBatches(
  persistence: EventPersistence,
  runInBackground: (Runnable) -> Unit,
  onComplete: () -> Unit = {},
  discardOnFailure: () -> Boolean = { false },
  deliver: (List<SdkEvent>, (Boolean) -> Unit) -> Unit,
) {
  val logger = DefaultSdkLogger()
  val pending =
    try {
      persistence.loadPending().take(MAX_REPLAY_BATCHES_PER_LAUNCH)
    } catch (error: Exception) {
      logger.w("EventBatchReplay", error) { "Could not load pending batches" }
      onComplete()
      return
    }

  fun submit(index: Int) {
    if (index >= pending.size) {
      onComplete()
      return
    }
    val (batchId, events) = pending[index]
    val completed = AtomicBoolean(false)
    val complete: (Boolean) -> Unit = { delivered ->
      if (completed.compareAndSet(false, true)) {
        val discard = !delivered && discardOnFailure()
        try {
          runInBackground(
            Runnable {
              try {
                if (delivered || discard) persistence.removeBatch(batchId)
                else persistence.recordReplayFailure(batchId)
              } catch (error: Exception) {
                logger.w("EventBatchReplay", error) { "Could not update pending batch $batchId" }
                onComplete()
                return@Runnable
              }
              if (delivered) submit(index + 1) else onComplete()
            }
          )
        } catch (error: Exception) {
          logger.w("EventBatchReplay", error) { "Could not schedule replay completion" }
          onComplete()
        }
      }
    }
    try {
      deliver(events, complete)
    } catch (error: Exception) {
      logger.w("EventBatchReplay", error) { "Could not submit pending batch $batchId" }
      complete(false)
    }
  }
  submit(0)
}
