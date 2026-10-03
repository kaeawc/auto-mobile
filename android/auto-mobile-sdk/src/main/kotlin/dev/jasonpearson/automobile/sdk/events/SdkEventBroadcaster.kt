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
  internal fun broadcastBatch(
    context: Context,
    events: List<SdkEvent>,
    onUndelivered: ((List<SdkEvent>) -> Unit)? = null,
    onComplete: (Boolean) -> Unit = {},
  ) {
    val generation = deliveryGeneration.get()
    val chunks = splitEventBatches(events, context.packageName, MAX_BATCH_BYTES)
    var remaining = chunks.size
    var allDelivered = true
    val completionLock = Any()
    if (chunks.isEmpty()) {
      if (generation == deliveryGeneration.get()) onComplete(true)
      return
    }
    for (chunk in chunks) {
      sendBatchIntent(
        context,
        serializeChunk(chunk, context.packageName, MAX_BATCH_BYTES),
        generation = generation,
      ) { delivered ->
        if (generation != deliveryGeneration.get()) return@sendBatchIntent
        if (!delivered) {
          // A supplied callback owns persistence and drop accounting: persisted events
          // are retained, not dropped. Replay supplies a no-op because it already has a file.
          if (onUndelivered != null) onUndelivered(chunk)
          else dropCounter?.increment(DropReason.DELIVERY_FAILED, chunk.size)
        }
        synchronized(completionLock) {
          allDelivered = allDelivered && delivered
          remaining--
          if (remaining == 0 && generation == deliveryGeneration.get()) onComplete(allDelivered)
        }
      }
    }
  }

  /** Serialized batches retained for existing callers and tests. */
  internal fun splitIntoBatches(
    events: List<SdkEvent>,
    applicationId: String?,
    maxBytes: Int = MAX_BATCH_BYTES,
  ): List<String> =
    splitEventBatches(events, applicationId, maxBytes).map {
      serializeChunk(it, applicationId, maxBytes)
    }

  private fun splitEventBatches(
    events: List<SdkEvent>,
    applicationId: String?,
    maxBytes: Int,
  ): List<List<SdkEvent>> {
    if (events.isEmpty()) return emptyList()
    if (
      serializeBatch(events, applicationId).toByteArray(Charsets.UTF_8).size <= maxBytes ||
        events.size == 1
    )
      return listOf(events.toList())
    val midpoint = events.size / 2
    return splitEventBatches(events.subList(0, midpoint), applicationId, maxBytes) +
      splitEventBatches(events.subList(midpoint, events.size), applicationId, maxBytes)
  }

  private fun serializeChunk(
    events: List<SdkEvent>,
    applicationId: String?,
    maxBytes: Int,
  ): String {
    val json = serializeBatch(events, applicationId)
    // Preserve the existing oversized single-event envelope.
    return if (events.size == 1 && json.toByteArray(Charsets.UTF_8).size > maxBytes)
      serializeBatch(events, null)
    else json
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
    attempt: Int = 0,
    generation: Long,
    onResult: (Boolean) -> Unit,
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
      // Broadcast failures are retried and reported; SDK delivery must not crash the host.
      if (generation != deliveryGeneration.get()) return
      if (attempt < retryPolicy.maxRetries) {
        val delayMs = retryPolicy.delayForAttempt(attempt)
        retryHandler.postDelayed(
          {
            sendBatchIntent(
              context,
              batchJson,
              attempt + 1,
              generation = generation,
              onResult = onResult,
            )
          },
          delayMs,
        )
      } else if (generation == deliveryGeneration.get()) {
        onResult(false)
      }
      return
    }
    if (generation == deliveryGeneration.get()) onResult(true)
  }
}
