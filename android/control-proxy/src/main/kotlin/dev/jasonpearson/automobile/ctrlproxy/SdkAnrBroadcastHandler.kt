package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.SdkAnrEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer

/** ANR parsing, synchronous handoff and bounded replay deduplication, like SDK event batches. */
internal class SdkAnrBroadcastHandler(
  private val enqueue: (SdkAnrEvent) -> Boolean,
  private val log: SdkEventBatchBroadcastHandler.LogSink,
  private val recentAnrCapacity: Int = 256,
) {
  private val acceptedIds = LinkedHashSet<String>()

  init {
    require(recentAnrCapacity > 0)
  }

  fun handle(
    eventJson: String?,
    result: SdkEventBatchBroadcastHandler.ResultSink,
    deliveryId: String? = null,
  ) {
    val event = eventJson?.let(SdkEventSerializer::anrEventFromJson)
    val code =
      if (event == null) {
        SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD
      } else {
        log.debug("Received ANR: pid=${event.pid} from ${event.applicationId}")
        val accepted =
          synchronized(acceptedIds) {
            if (deliveryId != null && deliveryId in acceptedIds) {
              true
            } else if (enqueue(event)) {
              if (deliveryId != null) {
                acceptedIds.add(deliveryId)
                if (acceptedIds.size > recentAnrCapacity) {
                  val oldest = acceptedIds.iterator()
                  oldest.next()
                  oldest.remove()
                }
              }
              true
            } else false
          }
        if (accepted) SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED
        else SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_QUEUE_FULL
      }
    if (result.isOrdered) result.setResultCode(code)
  }
}
