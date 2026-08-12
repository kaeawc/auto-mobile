package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkNavigationEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

internal class SdkEventBatchProcessor(
  private val scope: CoroutineScope,
  private val navigationEventAccumulator: NavigationEventAccumulator,
  private val awaitClientConnection: suspend () -> Unit = {},
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
  private var started = false

  /**
   * Begins draining queued SDK events.
   *
   * Receivers can enqueue before this point while the accessibility service completes its remaining
   * initialization. Each delivery waits for an active WebSocket client, so startup and reconnect
   * gaps retain queued events instead of discarding them.
   */
  @Synchronized
  fun start() {
    if (started) return
    started = true
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
        deliverNavigationEvent(
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
        deliverNavigationEvent(navigationEventAccumulator.addSdkNavigationEvent(event))
      } else {
        awaitClientConnection()
        broadcastSdkEvent(event)
      }
    }
  }

  private suspend fun deliverNavigationEvent(event: TimestampedNavigationEvent) {
    awaitClientConnection()
    broadcastNavigationEvent(event)
  }

  private companion object {
    const val QUEUE_CAPACITY = 64
  }
}
