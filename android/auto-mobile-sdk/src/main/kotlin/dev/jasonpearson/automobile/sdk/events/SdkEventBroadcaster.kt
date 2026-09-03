package dev.jasonpearson.automobile.sdk.events

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.annotation.RestrictTo
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.SdkConstants
import java.util.concurrent.atomic.AtomicLong

/**
 * Broadcasts batched SDK events via Intent for cross-process communication.
 *
 * Serializes events as [SdkEventBatch] JSON and sends via scoped broadcast Intent. Caps batch JSON
 * at [MAX_BATCH_BYTES] and splits if exceeded to respect the Android Intent size limit (~1MB).
 */
@RestrictTo(RestrictTo.Scope.LIBRARY_GROUP)
object SdkEventBroadcaster {

  const val MAX_BATCH_BYTES =
    100_000 // 100KB per Intent — lower to avoid TransactionTooLargeException

  internal var retryPolicy: RetryPolicy = RetryPolicy()
  internal var retryHandler: Handler = Handler(Looper.getMainLooper())
  internal var dropCounter: DropCounter? = null
  private val deliveryGeneration = AtomicLong()

  /** Reset mutable state. Called by [AutoMobileSDK.shutdown]. */
  internal fun reset() {
    deliveryGeneration.incrementAndGet()
    retryHandler.removeCallbacksAndMessages(null)
    retryPolicy = RetryPolicy()
    retryHandler = Handler(Looper.getMainLooper())
    dropCounter = null
  }

  /**
   * Broadcast a batch of events. Called by [SdkEventBuffer] on flush.
   *
   * @param context Application context for sending broadcasts
   * @param events The events to broadcast
   */
  internal fun broadcastBatch(context: Context, events: List<SdkEvent>) {
    if (events.isEmpty()) return

    val generation = deliveryGeneration.get()
    val batches = splitIntoBatches(events, context.packageName)
    val eventCount = events.size
    val perBatch = if (batches.size > 1) eventCount / batches.size else eventCount
    for ((i, json) in batches.withIndex()) {
      val count = if (i == batches.lastIndex) eventCount - perBatch * i else perBatch
      sendBatchIntent(context, json, count, generation = generation)
    }
  }

  /**
   * Splits events into serialized JSON batches that each fit within [MAX_BATCH_BYTES]. Visible for
   * testing.
   *
   * @param events The events to batch
   * @param applicationId Application ID for the batch envelope
   * @param maxBytes Maximum serialized size per batch
   * @return List of serialized JSON strings, one per batch
   */
  internal fun splitIntoBatches(
    events: List<SdkEvent>,
    applicationId: String?,
    maxBytes: Int = MAX_BATCH_BYTES,
  ): List<String> {
    if (events.isEmpty()) return emptyList()

    val json = serializeBatch(events, applicationId)
    if (json.toByteArray(Charsets.UTF_8).size <= maxBytes) {
      return listOf(json)
    }

    val midpoint = events.size / 2
    if (midpoint == 0) {
      // Single event that's too large — send it anyway
      return listOf(serializeBatch(events, null))
    }

    return splitIntoBatches(events.subList(0, midpoint), applicationId, maxBytes) +
      splitIntoBatches(events.subList(midpoint, events.size), applicationId, maxBytes)
  }

  private fun serializeBatch(events: List<SdkEvent>, applicationId: String?): String =
    SdkEventSerializer.toJson(
      SdkEventBatch(
        timestamp = System.currentTimeMillis(),
        applicationId = applicationId,
        events = events,
      )
    )

  private const val ACCESSIBILITY_SERVICE_PACKAGE = "dev.jasonpearson.automobile.ctrlproxy"

  private fun sendBatchIntent(
    context: Context,
    batchJson: String,
    eventCount: Int = 1,
    attempt: Int = 0,
    generation: Long,
  ) {
    if (generation != deliveryGeneration.get()) return

    try {
      val intent =
        Intent(SdkEventSerializer.ACTION_SDK_EVENT_BATCH).apply {
          putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, batchJson)
          putExtra(
            SdkEventSerializer.EXTRA_SDK_EVENT_TYPE,
            SdkEventSerializer.EventTypes.EVENT_BATCH,
          )
          setPackage(SdkConstants.CTRL_PROXY_PACKAGE)
        }
      context.sendBroadcast(intent)
    } catch (_: Exception) {
      if (generation != deliveryGeneration.get()) return
      if (attempt < retryPolicy.maxRetries) {
        val delayMs = retryPolicy.delayForAttempt(attempt)
        retryHandler.postDelayed(
          {
            sendBatchIntent(
              context,
              batchJson,
              eventCount,
              attempt + 1,
              generation = generation,
            )
          },
          delayMs,
        )
      } else if (generation == deliveryGeneration.get()) {
        dropCounter?.increment(DropReason.DELIVERY_FAILED, eventCount)
      }
    }
  }
}
