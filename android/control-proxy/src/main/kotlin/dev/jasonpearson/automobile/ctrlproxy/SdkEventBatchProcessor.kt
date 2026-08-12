package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

internal class SdkEventBatchProcessor(
  scope: CoroutineScope,
  private val navigationEventAccumulator: NavigationEventAccumulator,
  private val broadcastNavigationEvent: suspend (TimestampedNavigationEvent) -> Unit,
  private val broadcastSdkEvent: suspend (SdkEvent) -> Unit,
) {
  private val queuedBatches = Channel<SdkEventBatch>(Channel.UNLIMITED)

  init {
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
  fun enqueue(batch: SdkEventBatch): Boolean = queuedBatches.trySend(batch).isSuccess

  private suspend fun process(batch: SdkEventBatch) {
    for (event in batch.events) {
      if (event is SdkNavigationEvent) {
        broadcastNavigationEvent(navigationEventAccumulator.addSdkNavigationEvent(event))
      } else {
        broadcastSdkEvent(event)
      }
    }
  }
}
