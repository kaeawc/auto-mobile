package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal class SdkEventBatchProcessor(
  private val navigationEventAccumulator: NavigationEventAccumulator,
  private val broadcastNavigationEvent: suspend (TimestampedNavigationEvent) -> Unit,
  private val broadcastSdkEvent: suspend (SdkEvent) -> Unit,
) {
  private val mutex = Mutex()

  suspend fun process(batch: SdkEventBatch) {
    mutex.withLock {
      for (event in batch.events) {
        if (event is SdkNavigationEvent) {
          broadcastNavigationEvent(navigationEventAccumulator.addSdkNavigationEvent(event))
        } else {
          broadcastSdkEvent(event)
        }
      }
    }
  }
}
