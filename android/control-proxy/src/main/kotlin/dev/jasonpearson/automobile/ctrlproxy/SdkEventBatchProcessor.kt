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
  private sealed interface QueuedEvent {
    data class Batch(val batch: SdkEventBatch) : QueuedEvent

    data class Navigation(
      val destination: String,
      val source: String,
      val arguments: Map<String, String>,
      val metadata: Map<String, String>,
      val applicationId: String?,
      val timestamp: Long,
    ) : QueuedEvent
  }

  // BroadcastReceiver.onReceive cannot suspend. Keep a bounded handoff queue so a stalled
  // WebSocket client cannot retain arbitrary SDK event batches in the CtrlProxy process.
  private val queuedEvents = Channel<QueuedEvent>(QUEUE_CAPACITY)

  init {
    scope.launch {
      for (event in queuedEvents) {
        process(event)
      }
    }
  }

  /**
   * Queues a batch from the broadcast receiver before asynchronous dispatch so the actor preserves
   * receiver arrival order. Returns false when the bounded queue is full; callers must log that
   * overload because the broadcast cannot be retried synchronously.
   */
  fun enqueue(batch: SdkEventBatch): Boolean =
    queuedEvents.trySend(QueuedEvent.Batch(batch)).isSuccess

  /** Queues a single navigation event from the legacy navigation broadcast receiver. */
  fun enqueueNavigationEvent(
    destination: String,
    source: String,
    arguments: Map<String, String>,
    metadata: Map<String, String>,
    applicationId: String?,
    timestamp: Long,
  ): Boolean =
    queuedEvents
      .trySend(
        QueuedEvent.Navigation(
          destination = destination,
          source = source,
          arguments = arguments,
          metadata = metadata,
          applicationId = applicationId,
          timestamp = timestamp,
        )
      )
      .isSuccess

  private suspend fun process(event: QueuedEvent) {
    when (event) {
      is QueuedEvent.Batch -> process(event.batch)
      is QueuedEvent.Navigation -> {
        broadcastNavigationEvent(
          navigationEventAccumulator.addEvent(
            destination = event.destination,
            source = event.source,
            arguments = event.arguments,
            metadata = event.metadata,
            applicationId = event.applicationId,
            timestamp = event.timestamp,
            publishLatestEvent = false,
          )
        )
      }
    }
  }

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
    const val QUEUE_CAPACITY = 64
  }
}
