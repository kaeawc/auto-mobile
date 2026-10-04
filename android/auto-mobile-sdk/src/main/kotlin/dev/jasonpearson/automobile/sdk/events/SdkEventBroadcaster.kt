package dev.jasonpearson.automobile.sdk.events

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.annotation.RestrictTo
import dev.jasonpearson.automobile.protocol.SdkEvent
import dev.jasonpearson.automobile.protocol.SdkEventBatch
import dev.jasonpearson.automobile.protocol.SdkEventBatchBroadcastContract
import dev.jasonpearson.automobile.protocol.SdkEventSerializer
import dev.jasonpearson.automobile.sdk.SdkConstants
import dev.jasonpearson.automobile.sdk.logging.DefaultSdkLogger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

internal enum class BatchDeliveryOutcome {
  DELIVERED,
  UNDELIVERED,
  INVALID_PAYLOAD,
}

/** Timeout scheduling and completion dispatch share the SDK buffer executor in production. */
internal interface BatchDeliveryScheduler {
  fun schedule(task: Runnable, delayMs: Long): () -> Unit

  fun execute(task: Runnable)
}

/** Android bridge kept separate from the delivery state machine for deterministic JVM tests. */
internal interface BatchBroadcastSender {
  fun send(context: Context, batchJson: String, ordered: Boolean, onResult: (Int) -> Unit)
}

private class AndroidBatchBroadcastSender(private val resultHandler: Handler) :
  BatchBroadcastSender {
  override fun send(
    context: Context,
    batchJson: String,
    ordered: Boolean,
    onResult: (Int) -> Unit,
  ) {
    val intent =
      Intent(SdkEventSerializer.ACTION_SDK_EVENT_BATCH).apply {
        putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, batchJson)
        putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_TYPE, SdkEventSerializer.EventTypes.EVENT_BATCH)
        setPackage(SdkConstants.CTRL_PROXY_PACKAGE)
      }
    if (!ordered) {
      context.sendBroadcast(intent)
      return
    }
    val receiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
          onResult(resultCode)
        }
      }
    context.sendOrderedBroadcast(intent, null, receiver, resultHandler, 0, null, null)
  }
}

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
  internal var broadcastSender: BatchBroadcastSender? = null
  internal var capabilityGate: SdkEventAckCapability? = null
  internal var deliveryScheduler: BatchDeliveryScheduler? = null
  internal const val ACK_TIMEOUT_MS = 5_000L
  private val logger = DefaultSdkLogger()
  private val deliveryGeneration = AtomicLong()

  /** Reset mutable state. Called by [AutoMobileSDK.shutdown]. */
  internal fun reset() {
    deliveryGeneration.incrementAndGet()
    retryHandler.removeCallbacksAndMessages(null)
    retryPolicy = RetryPolicy()
    retryHandler = Handler(Looper.getMainLooper())
    dropCounter = null
    broadcastSender = null
    capabilityGate = null
    deliveryScheduler = null
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
    onAcknowledged: () -> Unit = {},
    onFinished: (BatchDeliveryOutcome) -> Unit = {},
    splitBatches: Boolean = true,
  ) {
    val generation = deliveryGeneration.get()
    val gate =
      synchronized(this) {
        capabilityGate
          ?: SdkEventAckCapability(AndroidAckPackageInfoReader(context.packageManager)).also {
            capabilityGate = it
          }
      }
    val requireAck = gate.isSupported()
    // Persisted files represent one delivery unit. Replay sends that exact unit so a mixed
    // split result cannot discard retryable events together with an invalid chunk.
    val chunks =
      if (splitBatches) splitEventBatches(events, context.packageName, MAX_BATCH_BYTES)
      else if (events.isEmpty()) emptyList() else listOf(events)
    var remaining = chunks.size
    var allDelivered = true
    var invalidPayload = false
    val completionLock = Any()
    if (chunks.isEmpty()) {
      if (generation == deliveryGeneration.get()) {
        onComplete(true)
        onFinished(BatchDeliveryOutcome.DELIVERED)
      }
      return
    }
    for (chunk in chunks) {
      sendBatchIntent(
        context,
        serializeChunk(chunk, context.packageName, MAX_BATCH_BYTES),
        generation = generation,
        requireAck = requireAck,
      ) { outcome ->
        val delivered = outcome == BatchDeliveryOutcome.DELIVERED
        if (generation != deliveryGeneration.get()) return@sendBatchIntent
        if (outcome == BatchDeliveryOutcome.INVALID_PAYLOAD) {
          dropCounter?.increment(DropReason.DELIVERY_FAILED, chunk.size)
          logger.w("SdkEventBroadcaster") {
            "Dropping ${chunk.size} events: CtrlProxy rejected invalid payload"
          }
        } else if (!delivered) {
          // A supplied callback owns persistence and drop accounting: persisted events
          // are retained, not dropped. Replay supplies a no-op because it already has a file.
          if (onUndelivered != null) onUndelivered(chunk)
          else dropCounter?.increment(DropReason.DELIVERY_FAILED, chunk.size)
        }
        synchronized(completionLock) {
          allDelivered = allDelivered && delivered
          invalidPayload = invalidPayload || outcome == BatchDeliveryOutcome.INVALID_PAYLOAD
          remaining--
          if (remaining == 0 && generation == deliveryGeneration.get()) {
            onComplete(allDelivered)
            onFinished(
              when {
                allDelivered -> BatchDeliveryOutcome.DELIVERED
                invalidPayload -> BatchDeliveryOutcome.INVALID_PAYLOAD
                else -> BatchDeliveryOutcome.UNDELIVERED
              }
            )
            if (allDelivered && requireAck) onAcknowledged()
          }
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

  private fun scheduler(): BatchDeliveryScheduler =
    deliveryScheduler
      ?: object : BatchDeliveryScheduler {
        override fun schedule(task: Runnable, delayMs: Long): () -> Unit {
          check(retryHandler.postDelayed(task, delayMs))
          return { retryHandler.removeCallbacks(task) }
        }

        override fun execute(task: Runnable) {
          task.run()
        }
      }

  private fun sendBatchIntent(
    context: Context,
    batchJson: String,
    attempt: Int = 0,
    generation: Long,
    requireAck: Boolean,
    onResult: (BatchDeliveryOutcome) -> Unit,
  ) {
    if (generation != deliveryGeneration.get()) return
    val completed = AtomicBoolean(false)
    val scheduler = scheduler()
    var cancelTimeout: (() -> Unit)? = null
    fun finish(outcome: BatchDeliveryOutcome) {
      if (completed.compareAndSet(false, true)) {
        cancelTimeout?.invoke()
        if (generation == deliveryGeneration.get()) onResult(outcome)
      }
    }
    try {
      val timeoutCancellation =
        if (requireAck) {
          scheduler.schedule(Runnable { finish(BatchDeliveryOutcome.UNDELIVERED) }, ACK_TIMEOUT_MS)
        } else null
      cancelTimeout = timeoutCancellation
      val sender = broadcastSender ?: AndroidBatchBroadcastSender(retryHandler)
      sender.send(context, batchJson, requireAck) { resultCode ->
        // Claim the outcome on arrival, before the executor hop. A timeout cannot win later.
        val outcome =
          when (resultCode) {
            SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED -> BatchDeliveryOutcome.DELIVERED
            SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD ->
              BatchDeliveryOutcome.INVALID_PAYLOAD
            else -> BatchDeliveryOutcome.UNDELIVERED
          }
        if (completed.compareAndSet(false, true)) {
          timeoutCancellation?.invoke()
          scheduler.execute(
            Runnable {
              if (generation == deliveryGeneration.get()) onResult(outcome)
            }
          )
        }
      }
      if (!requireAck) finish(BatchDeliveryOutcome.DELIVERED)
    } catch (error: Exception) {
      logger.w("SdkEventBroadcaster", error) { "Could not send SDK event batch" }
      // A throw after a synchronous result cannot retry or report a second outcome.
      if (!completed.compareAndSet(false, true)) return
      cancelTimeout?.invoke()
      if (generation != deliveryGeneration.get()) return
      if (attempt < retryPolicy.maxRetries) {
        try {
          cancelTimeout =
            scheduler.schedule(
              Runnable {
                sendBatchIntent(context, batchJson, attempt + 1, generation, requireAck, onResult)
              },
              retryPolicy.delayForAttempt(attempt),
            )
        } catch (retryError: Exception) {
          logger.w("SdkEventBroadcaster", retryError) { "Could not schedule SDK event retry" }
          onResult(BatchDeliveryOutcome.UNDELIVERED)
        }
      } else {
        onResult(BatchDeliveryOutcome.UNDELIVERED)
      }
    }
  }
}
