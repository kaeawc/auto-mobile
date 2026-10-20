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
    deliver: (List<SdkEvent>, String?, (BatchDeliveryOutcome) -> Unit) -> Unit,
  ) {
    if (!running.compareAndSet(false, true)) return
    try {
      persistence.cleanup()
      var outcome = BatchDeliveryOutcome.UNDELIVERED
      replayEventBatches(
        persistence,
        runInBackground,
        onComplete = { running.set(false) },
        discardOnFailure = { outcome == BatchDeliveryOutcome.INVALID_PAYLOAD },
        recordFailure = {
          outcome == BatchDeliveryOutcome.REJECTED ||
            outcome == BatchDeliveryOutcome.LEGACY_UNDELIVERED
        },
        stopOnFailure = {
          outcome != BatchDeliveryOutcome.INVALID_PAYLOAD &&
            outcome != BatchDeliveryOutcome.LEGACY_UNDELIVERED
        },
      ) { events, deliveryId, complete ->
        outcome = BatchDeliveryOutcome.UNDELIVERED
        deliver(events, deliveryId) { result ->
          outcome = result
          complete(result == BatchDeliveryOutcome.DELIVERED)
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
 * refused hop leaves the remaining files for a later pass. Legacy failures continue; acknowledged
 * replay stops when delivery is unavailable or explicitly rejected. Invalid files are skipped even
 * when removal fails, and the fixed snapshot visits each file at most once per pass.
 */
internal fun replayEventBatches(
  persistence: EventPersistence,
  runInBackground: (Runnable) -> Unit,
  onComplete: () -> Unit = {},
  discardOnFailure: () -> Boolean = { false },
  recordFailure: () -> Boolean = { true },
  stopOnFailure: () -> Boolean = { false },
  deliver: (List<SdkEvent>, String?, (Boolean) -> Unit) -> Unit,
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

  PendingBatchReplay(
      persistence,
      pending,
      logger,
      ReplayCallbacks(
        runInBackground,
        onComplete,
        discardOnFailure,
        recordFailure,
        stopOnFailure,
        deliver,
      ),
    )
    .submit(0)
}

private data class ReplayCallbacks(
  val runInBackground: (Runnable) -> Unit,
  val onComplete: () -> Unit,
  val discardOnFailure: () -> Boolean,
  val recordFailure: () -> Boolean,
  val stopOnFailure: () -> Boolean,
  val deliver: (List<SdkEvent>, String?, (Boolean) -> Unit) -> Unit,
)

private data class PendingBatchReplay(
  val persistence: EventPersistence,
  val pending: List<PendingEventBatch>,
  val logger: DefaultSdkLogger,
  val callbacks: ReplayCallbacks,
)

private fun PendingBatchReplay.submit(index: Int) {
  if (index >= pending.size) {
    callbacks.onComplete()
    return
  }
  val batch = pending[index]
  val (batchId, events, deliveryId) = batch
  val completed = AtomicBoolean(false)
  val complete: (Boolean) -> Unit = { delivered ->
    completeBatch(index, batch, completed, delivered)
  }
  try {
    callbacks.deliver(events, deliveryId, complete)
  } catch (error: Exception) {
    logger.w("EventBatchReplay", error) { "Could not submit pending batch $batchId" }
    complete(false)
  }
}

private fun PendingBatchReplay.completeBatch(
  index: Int,
  batch: PendingEventBatch,
  completed: AtomicBoolean,
  delivered: Boolean,
) {
  if (completed.compareAndSet(false, true)) {
    val discard = !delivered && callbacks.discardOnFailure()
    val record = !delivered && !discard && callbacks.recordFailure()
    val stop = !delivered && callbacks.stopOnFailure()
    try {
      callbacks.runInBackground(
        Runnable {
          updateBatch(batch.storageId, delivered, discard, record)
          if (stop) callbacks.onComplete() else submit(index + 1)
        },
      )
    } catch (error: Exception) {
      logger.w("EventBatchReplay", error) { "Could not schedule replay completion" }
      callbacks.onComplete()
    }
  }
}

private fun PendingBatchReplay.updateBatch(
  batchId: String,
  delivered: Boolean,
  discard: Boolean,
  record: Boolean,
) {
  try {
    if (delivered || discard) persistence.removeBatch(batchId)
    else if (record) persistence.recordReplayFailure(batchId)
  } catch (error: Exception) {
    logger.w("EventBatchReplay", error) { "Could not update pending batch $batchId" }
  }
}
