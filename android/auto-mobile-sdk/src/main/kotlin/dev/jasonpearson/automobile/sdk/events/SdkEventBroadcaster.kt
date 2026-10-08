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
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal enum class BatchDeliveryOutcome {
  DELIVERED,
  UNDELIVERED,
  REJECTED,
  LEGACY_UNDELIVERED,
  INVALID_PAYLOAD,
}

/** The failed chunk and unsent suffix need the buffer's flush-exception fallback. */
internal class UnsentEventBatchesException(
  val batches: List<Pair<List<SdkEvent>, String?>>,
  cause: Exception,
) : RuntimeException("Could not deliver SDK event chunk", cause)

/** Timeout scheduling and completion dispatch share the SDK buffer executor in production. */
internal interface BatchDeliveryScheduler {
  /** Null means shutdown has begun: send once and resolve without waiting or retrying. */
  fun schedule(task: Runnable, delayMs: Long): (() -> Unit)?

  fun execute(task: Runnable)
}

/** Android bridge kept separate from the delivery state machine for deterministic JVM tests. */
internal interface BatchBroadcastSender {
  fun send(
    context: Context,
    batchJson: String,
    batchId: String?,
    ordered: Boolean,
    onResult: (Int) -> Unit,
  )
}

private class AndroidBatchBroadcastSender(private val resultHandler: Handler) :
  BatchBroadcastSender {
  override fun send(
    context: Context,
    batchJson: String,
    batchId: String?,
    ordered: Boolean,
    onResult: (Int) -> Unit,
  ) {
    val intent =
      Intent(SdkEventSerializer.ACTION_SDK_EVENT_BATCH).apply {
        putExtra(SdkEventSerializer.EXTRA_SDK_EVENT_JSON, batchJson)
        batchId?.let { putExtra(SdkEventBatchBroadcastContract.EXTRA_BATCH_ID, it) }
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

  internal var batchIdProvider: () -> String = { UUID.randomUUID().toString() }
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
    batchIdProvider = { UUID.randomUUID().toString() }
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
    onUndelivered: ((List<SdkEvent>, String?) -> Unit)? = null,
    onComplete: (Boolean) -> Unit = {},
    onAcknowledged: () -> Unit = {},
    onFinished: (BatchDeliveryOutcome) -> Unit = {},
    splitBatches: Boolean = true,
    // A null replay id preserves old array-file behavior. New delivery chunks allocate once.
    batchId: String? = null,
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
      if (splitBatches || !requireAck)
        splitEventBatches(events, context.packageName, MAX_BATCH_BYTES)
      else if (events.isEmpty()) emptyList() else listOf(events)
    var remaining = chunks.size
    var allDelivered = true
    var failedOutcome = BatchDeliveryOutcome.UNDELIVERED
    val completionLock = Any()
    if (chunks.isEmpty()) {
      if (generation == deliveryGeneration.get()) {
        onComplete(true)
        onFinished(BatchDeliveryOutcome.DELIVERED)
      }
      return
    }
    // Allocate every identity before sending: a failing provider cannot strand a sent prefix.
    val chunkIds =
      chunks.indices.map { index ->
        if (splitBatches) batchIdProvider()
        else if (batchId == null || chunks.size == 1) batchId
        // Legacy CtrlProxy may require splitting a stored unit. Derive stable child identities
        // so returning to an ack-capable receiver cannot mistake one child for another.
        else "$batchId:$index"
      }
    for ((index, chunk) in chunks.withIndex()) {
      val chunkId = chunkIds[index]
      val json =
        try {
          serializeChunk(chunk, context.packageName, MAX_BATCH_BYTES)
        } catch (error: Exception) {
          // Earlier sends own their outcomes; retain only this chunk and the unsent suffix.
          throw UnsentEventBatchesException(chunks.drop(index).zip(chunkIds.drop(index)), error)
        }
      try {
        sendBatchIntent(
          context,
          json,
          batchId = chunkId,
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
            if (onUndelivered != null) onUndelivered(chunk, chunkId)
            else dropCounter?.increment(DropReason.DELIVERY_FAILED, chunk.size)
          }
          synchronized(completionLock) {
            allDelivered = allDelivered && delivered
            if (
              !delivered &&
                (failedOutcome != BatchDeliveryOutcome.INVALID_PAYLOAD ||
                  outcome == BatchDeliveryOutcome.INVALID_PAYLOAD)
            ) {
              failedOutcome = outcome
            }
            remaining--
            if (remaining == 0 && generation == deliveryGeneration.get()) {
              onComplete(allDelivered)
              onFinished(if (allDelivered) BatchDeliveryOutcome.DELIVERED else failedOutcome)
              if (allDelivered && requireAck) onAcknowledged()
            }
          }
        }
      } catch (error: Exception) {
        // Preserve legacy and first-chunk fallbacks; earlier ack sends still own their outcomes.
        if (!requireAck || index == 0) throw error
        // This send's outcome is unknown; its existing id absorbs any duplicate on replay.
        throw UnsentEventBatchesException(chunks.drop(index).zip(chunkIds.drop(index)), error)
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
      ),
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

  // A null outcome marks an aborted attempt that owns a retry, not a completed delivery.
  private class AttemptResolution(val outcome: BatchDeliveryOutcome?)

  private fun sendBatchIntent(
    context: Context,
    batchJson: String,
    batchId: String?,
    attempt: Int = 0,
    generation: Long,
    requireAck: Boolean,
    onResult: (BatchDeliveryOutcome) -> Unit,
  ) {
    if (generation != deliveryGeneration.get()) return
    val resolution = AtomicReference<AttemptResolution?>()
    val dispatched = AtomicBoolean(false)
    val scheduler = if (requireAck) scheduler() else null
    var cancelTimeout: (() -> Unit)? = null
    fun dispatchResult() {
      val outcome = resolution.get()?.outcome ?: return
      if (dispatched.compareAndSet(false, true)) {
        cancelTimeout?.invoke()
        if (generation == deliveryGeneration.get()) onResult(outcome)
      }
    }
    fun finish(outcome: BatchDeliveryOutcome) {
      resolution.compareAndSet(null, AttemptResolution(outcome))
      // Shutdown also dispatches an already-arrived result whose executor hop is still pending.
      dispatchResult()
    }
    try {
      val timeoutCancellation =
        if (requireAck) {
          requireNotNull(scheduler) { "Acknowledged delivery requires a scheduler" }
            .schedule(
              Runnable { finish(BatchDeliveryOutcome.UNDELIVERED) },
              ACK_TIMEOUT_MS,
            )
        } else null
      cancelTimeout = timeoutCancellation
      val sender = broadcastSender ?: AndroidBatchBroadcastSender(retryHandler)
      sender.send(context, batchJson, batchId, requireAck) { resultCode ->
        // Claim the outcome on arrival, before the executor hop. A timeout cannot win later.
        val outcome =
          when (resultCode) {
            SdkEventBatchBroadcastContract.RESULT_BATCH_ACCEPTED -> BatchDeliveryOutcome.DELIVERED
            SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_INVALID_PAYLOAD ->
              BatchDeliveryOutcome.INVALID_PAYLOAD
            SdkEventBatchBroadcastContract.RESULT_BATCH_REJECTED_QUEUE_FULL ->
              BatchDeliveryOutcome.REJECTED
            else -> BatchDeliveryOutcome.UNDELIVERED
          }
        if (resolution.compareAndSet(null, AttemptResolution(outcome))) {
          // Keep the timeout tracked until dispatch. Shutdown can resolve the batch in the
          // gap between arrival and executor submission, without losing it or waiting for it.
          requireNotNull(scheduler) { "Acknowledged delivery requires a scheduler" }
            .execute(Runnable { dispatchResult() })
        }
      }
      if (!requireAck) finish(BatchDeliveryOutcome.DELIVERED)
      else if (timeoutCancellation == null) finish(BatchDeliveryOutcome.UNDELIVERED)
    } catch (error: Exception) {
      logger.w("SdkEventBroadcaster", error) { "Could not send SDK event batch" }
      // A throw after a synchronous result cannot retry or report a second outcome.
      if (!resolution.compareAndSet(null, AttemptResolution(null))) return
      cancelTimeout?.invoke()
      if (generation != deliveryGeneration.get()) return
      val failedOutcome =
        if (requireAck) BatchDeliveryOutcome.UNDELIVERED
        else BatchDeliveryOutcome.LEGACY_UNDELIVERED
      if (attempt < retryPolicy.maxRetries) {
        val retry = Runnable {
          sendBatchIntent(
            context,
            batchJson,
            batchId,
            attempt + 1,
            generation,
            requireAck,
            onResult,
          )
        }
        if (!requireAck) {
          // Preserve the pre-ack path, including Handler's refused-post behavior.
          retryHandler.postDelayed(retry, retryPolicy.delayForAttempt(attempt))
          return
        }
        try {
          cancelTimeout =
            requireNotNull(scheduler) { "Acknowledged delivery requires a scheduler" }
              .schedule(
                retry,
                retryPolicy.delayForAttempt(attempt),
              )
          if (cancelTimeout == null) onResult(failedOutcome)
        } catch (retryError: Exception) {
          logger.w("SdkEventBroadcaster", retryError) { "Could not schedule SDK event retry" }
          onResult(failedOutcome)
        }
      } else {
        onResult(failedOutcome)
      }
    }
  }
}
