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
    val completion =
      BatchCompletion(
        generation,
        requireAck,
        chunks.size,
        BatchCallbacks(
          onUndelivered,
          onComplete,
          onAcknowledged,
          onFinished,
          deliveryGeneration,
          logger,
        ),
      )
    if (chunks.isEmpty()) {
      if (generation == deliveryGeneration.get()) {
        onComplete(true)
        onFinished(BatchDeliveryOutcome.DELIVERED)
      }
      return
    }
    // Allocate every identity before sending: a failing provider cannot strand a sent prefix.
    val chunkIds = allocateChunkIds(chunks, splitBatches, batchId)
    for (index in chunks.indices) {
      sendChunk(context, chunks, chunkIds, index, completion)
    }
  }

  private fun allocateChunkIds(
    chunks: List<List<SdkEvent>>,
    splitBatches: Boolean,
    batchId: String?,
  ): List<String?> {
    return chunks.indices.map { index ->
      if (splitBatches) batchIdProvider()
      else if (batchId == null || chunks.size == 1) batchId
      // Legacy CtrlProxy may require splitting a stored unit. Derive stable child identities
      // so returning to an ack-capable receiver cannot mistake one child for another.
      else "$batchId:$index"
    }
  }

  private fun sendChunk(
    context: Context,
    chunks: List<List<SdkEvent>>,
    chunkIds: List<String?>,
    index: Int,
    completion: BatchCompletion,
  ) {
    val chunk = chunks[index]
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
        BatchSend(
          context,
          json,
          batchId = chunkId,
          generation = completion.generation,
          requireAck = completion.requireAck,
        ) { outcome ->
          completion.completeChunk(chunk, chunkId, outcome)
        },
      )
    } catch (error: Exception) {
      // Preserve legacy and first-chunk fallbacks; earlier ack sends still own their outcomes.
      if (!completion.requireAck || index == 0) throw error
      // This send's outcome is unknown; its existing id absorbs any duplicate on replay.
      throw UnsentEventBatchesException(chunks.drop(index).zip(chunkIds.drop(index)), error)
    }
  }

  private data class BatchCallbacks(
    val onUndelivered: ((List<SdkEvent>, String?) -> Unit)?,
    val onComplete: (Boolean) -> Unit,
    val onAcknowledged: () -> Unit,
    val onFinished: (BatchDeliveryOutcome) -> Unit,
    val deliveryGeneration: AtomicLong,
    val logger: DefaultSdkLogger,
  )

  private class BatchCompletion(
    val generation: Long,
    val requireAck: Boolean,
    var remaining: Int,
    val callbacks: BatchCallbacks,
  ) {
    private var allDelivered = true
    private var failedOutcome = BatchDeliveryOutcome.UNDELIVERED
    private val completionLock = Any()

    fun completeChunk(chunk: List<SdkEvent>, chunkId: String?, outcome: BatchDeliveryOutcome) {
      val delivered = outcome == BatchDeliveryOutcome.DELIVERED
      if (generation != callbacks.deliveryGeneration.get()) return
      if (outcome == BatchDeliveryOutcome.INVALID_PAYLOAD) {
        dropCounter?.increment(DropReason.DELIVERY_FAILED, chunk.size)
        callbacks.logger.w("SdkEventBroadcaster") {
          "Dropping ${chunk.size} events: CtrlProxy rejected invalid payload"
        }
      } else if (!delivered) {
        // A supplied callback owns persistence and drop accounting: persisted events
        // are retained, not dropped. Replay supplies a no-op because it already has a file.
        if (callbacks.onUndelivered != null) callbacks.onUndelivered(chunk, chunkId)
        else dropCounter?.increment(DropReason.DELIVERY_FAILED, chunk.size)
      }
      recordCompletion(delivered, outcome)
    }

    private fun recordCompletion(delivered: Boolean, outcome: BatchDeliveryOutcome) {
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
        if (remaining == 0 && generation == callbacks.deliveryGeneration.get()) {
          callbacks.onComplete(allDelivered)
          callbacks.onFinished(if (allDelivered) BatchDeliveryOutcome.DELIVERED else failedOutcome)
          if (allDelivered && requireAck) callbacks.onAcknowledged()
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

  private fun sendBatchIntent(send: BatchSend) {
    if (send.generation != deliveryGeneration.get()) return
    val resolution = AtomicReference<AttemptResolution?>()
    val dispatched = AtomicBoolean(false)
    val scheduler = if (send.requireAck) scheduler() else null
    val state =
      BatchAttempt(
        send,
        resolution,
        dispatched,
        scheduler,
        deliveryGeneration,
      )
    with(state) {
      try {
        val timeoutCancellation =
          if (send.requireAck) {
            requireNotNull(scheduler) { "Acknowledged delivery requires a scheduler" }
              .schedule(
                Runnable { finish(BatchDeliveryOutcome.UNDELIVERED) },
                ACK_TIMEOUT_MS,
              )
          } else null
        cancelTimeout = timeoutCancellation
        val sender = broadcastSender ?: AndroidBatchBroadcastSender(retryHandler)
        sender.send(send.context, send.batchJson, send.batchId, send.requireAck) { resultCode ->
          acceptResult(resultCode)
        }
        if (!send.requireAck) finish(BatchDeliveryOutcome.DELIVERED)
        else if (timeoutCancellation == null) finish(BatchDeliveryOutcome.UNDELIVERED)
      } catch (error: Exception) {
        logger.w("SdkEventBroadcaster", error) { "Could not send SDK event batch" }
        // A throw after a synchronous result cannot retry or report a second outcome.
        if (!resolution.compareAndSet(null, AttemptResolution(null))) return
        cancelTimeout?.invoke()
        if (send.generation != deliveryGeneration.get()) return
        retry()
      }
    }
  }

  private data class BatchSend(
    val context: Context,
    val batchJson: String,
    val batchId: String?,
    val attempt: Int = 0,
    val generation: Long,
    val requireAck: Boolean,
    val onResult: (BatchDeliveryOutcome) -> Unit,
  )

  private class BatchAttempt(
    val send: BatchSend,
    val resolution: AtomicReference<AttemptResolution?>,
    val dispatched: AtomicBoolean,
    val scheduler: BatchDeliveryScheduler?,
    private val deliveryGeneration: AtomicLong,
  ) {
    var cancelTimeout: (() -> Unit)? = null

    private fun dispatchResult() {
      val outcome = resolution.get()?.outcome ?: return
      if (dispatched.compareAndSet(false, true)) {
        cancelTimeout?.invoke()
        if (send.generation == deliveryGeneration.get()) send.onResult(outcome)
      }
    }

    fun acceptResult(resultCode: Int) {
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

    fun finish(outcome: BatchDeliveryOutcome) {
      resolution.compareAndSet(null, AttemptResolution(outcome))
      // Shutdown also dispatches an already-arrived result whose executor hop is still pending.
      dispatchResult()
    }
  }

  private fun BatchAttempt.retry() {
    val failedOutcome =
      if (send.requireAck) BatchDeliveryOutcome.UNDELIVERED
      else BatchDeliveryOutcome.LEGACY_UNDELIVERED
    if (send.attempt < retryPolicy.maxRetries) {
      val retry = Runnable {
        sendBatchIntent(
          send.copy(attempt = send.attempt + 1),
        )
      }
      if (!send.requireAck) {
        // Preserve the pre-ack path, including Handler's refused-post behavior.
        retryHandler.postDelayed(retry, retryPolicy.delayForAttempt(send.attempt))
        return
      }
      try {
        cancelTimeout =
          requireNotNull(scheduler) { "Acknowledged delivery requires a scheduler" }
            .schedule(
              retry,
              retryPolicy.delayForAttempt(send.attempt),
            )
        if (cancelTimeout == null) send.onResult(failedOutcome)
      } catch (retryError: Exception) {
        logger.w("SdkEventBroadcaster", retryError) { "Could not schedule SDK event retry" }
        send.onResult(failedOutcome)
      }
    } else {
      send.onResult(failedOutcome)
    }
  }
}
