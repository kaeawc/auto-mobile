package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

internal class SdkEventBatchProcessor(
  scope: CoroutineScope,
  private val navigationEventAccumulator: NavigationEventAccumulator,
  private val broadcastNavigationEvent: suspend (TimestampedNavigationEvent) -> Unit,
  private val broadcastSdkEvent: suspend (SdkEvent) -> Unit,
  queueCapacity: Int = DEFAULT_QUEUE_CAPACITY,
) {
  private val queuedBatches = Channel<SdkEventBatch>(queueCapacity)
  private val droppedBatches = AtomicLong()

  init {
    require(queueCapacity > 0) { "queueCapacity must be positive" }
    scope.launch {
      for (batch in queuedBatches) {
        process(batch)
      }
    }
  }

  /**
   * Queues a batch from the broadcast receiver before asynchronous dispatch so the actor preserves
   * receiver arrival order.
   */
  fun enqueue(batch: SdkEventBatch): Boolean {
    val queued = queuedBatches.trySend(batch).isSuccess
    if (!queued) {
      droppedBatches.incrementAndGet()
    }
    return queued
  }

  val droppedBatchCount: Long
    get() = droppedBatches.get()

  private suspend fun process(batch: SdkEventBatch) {
    for (event in batch.events) {
      if (event is SdkNavigationEvent) {
        broadcastNavigationEvent(navigationEventAccumulator.addSdkNavigationEvent(event))
      } else {
        broadcastSdkEvent(event)
      }
    }
  }

  private companion object {
    const val DEFAULT_QUEUE_CAPACITY = 64
  }
}
