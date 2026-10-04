package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer

/** Synchronous parsing and queue handoff for the SDK batch broadcast receiver. */
internal class SdkEventBatchBroadcastHandler(
  private val enqueue: (SdkEventBatch) -> Boolean,
  private val log: LogSink,
  private val recentBatchCapacity: Int = 256,
) {
  // Insertion order bounds memory and preserves the oldest-accepted eviction policy. 256 covers
  // the SDK's default 100-file backlog plus the processor's 64 queued batches with headroom.
  private val acceptedBatchIds = LinkedHashSet<String>()

  init {
    require(recentBatchCapacity > 0)
  }

  interface LogSink {
    fun debug(message: String)

    fun warn(message: String)
  }

  interface ResultSink {
    val isOrdered: Boolean

    fun setResultCode(code: Int)
  }

  fun handle(eventJson: String?, result: ResultSink, batchId: String? = null) {
    val batch = eventJson?.let(SdkEventSerializer::eventBatchFromJson)
    if (batch == null) {
      acknowledge(result, SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD)
      return
    }

    log.debug("Received event batch with ${batch.events.size} events")

    val accepted =
      synchronized(acceptedBatchIds) {
        if (batchId != null && batchId in acceptedBatchIds) {
          true
        } else if (enqueue(batch)) {
          // Record only a successful synchronous queue handoff, while still holding the lock.
          // Queue-full retries remain eligible; overlapping receivers cannot enqueue the same id.
          if (batchId != null) {
            acceptedBatchIds.add(batchId)
            if (acceptedBatchIds.size > recentBatchCapacity) {
              val oldest = acceptedBatchIds.iterator()
              oldest.next()
              oldest.remove()
            }
          }
          true
        } else {
          false
        }
      }
    if (accepted) {
      acknowledge(result, SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED)
    } else {
      log.warn(
        "Dropping SDK event batch with ${batch.events.size} events because the queue is full"
      )
      acknowledge(result, SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_QUEUE_FULL)
    }
  }

  private fun acknowledge(result: ResultSink, code: Int) {
    if (result.isOrdered) result.setResultCode(code)
  }
}
