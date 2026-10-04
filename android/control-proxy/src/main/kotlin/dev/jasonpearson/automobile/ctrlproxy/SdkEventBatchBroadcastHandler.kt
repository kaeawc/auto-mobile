package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer

/** Synchronous parsing and queue handoff for the SDK batch broadcast receiver. */
internal class SdkEventBatchBroadcastHandler(
  private val enqueue: (SdkEventBatch) -> Boolean,
  private val log: LogSink,
) {
  interface LogSink {
    fun debug(message: String)

    fun warn(message: String)
  }

  interface ResultSink {
    val isOrdered: Boolean

    fun setResultCode(code: Int)
  }

  fun handle(eventJson: String?, result: ResultSink) {
    val batch = eventJson?.let(SdkEventSerializer::eventBatchFromJson)
    if (batch == null) {
      acknowledge(result, SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD)
      return
    }

    log.debug("Received event batch with ${batch.events.size} events")

    if (enqueue(batch)) {
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
