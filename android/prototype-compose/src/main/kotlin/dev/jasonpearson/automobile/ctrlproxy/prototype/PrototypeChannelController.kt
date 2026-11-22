package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeChannelCoalescer
import dev.jasonpearson.automobile.protocol.PrototypeChannelLimits
import dev.jasonpearson.automobile.protocol.PrototypeChannelRoutes
import kotlin.random.Random
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The `/platform/realtime/<channel>/status` values. */
@InternalAutoMobilePrototypeApi
enum class PrototypeChannelStatus(val wireValue: String) {
  IDLE("idle"),
  CONNECTING("connecting"),
  OPEN("open"),
  RECONNECTING("reconnecting"),
  CLOSED("closed"),
  ERROR("error");

  val active: Boolean
    get() = this == CONNECTING || this == OPEN || this == RECONNECTING
}

/**
 * Where the controller's effects land. Every call is made under the controller's lock, in order, so
 * a runtime can apply [run]'s actions as one atomic write, as it does request completions.
 */
@InternalAutoMobilePrototypeApi
interface PrototypeChannelSink {
  /** The channel's `/platform/realtime/<channel>` snapshot changed. */
  suspend fun state(channel: String, state: JsonObject)

  /** A `realtime.status` or `realtime.frame` event for `platform.on` handlers. */
  suspend fun event(name: String, data: JsonObject)

  /** Route, callback or `statusKey` actions to apply with [event] as the handler's event. */
  suspend fun run(channel: String, actions: JsonArray, event: JsonElement)

  /** An unexpected throw from the sink or a transport, isolated so the channels keep running. */
  fun warn(message: String) = Unit
}

/**
 * The realtime channel state machine of one prototype (#14269): status, reconnect with full-jitter
 * backoff, the send queue, first-match routing and flush-window coalescing. Transports report on
 * any thread; their callbacks go through one ordered inbox so frames keep their order, and every
 * effect reaches the [sink] under a single lock.
 *
 * Attempts reset once a connection has stayed open for [STABLE_OPEN_MS], so a server that accepts
 * and drops at once still backs off. Sends made while connecting or reconnecting wait in a bounded
 * queue that is flushed on open and dropped when the channel closes.
 *
 * A sink call that throws goes to [onError] and the state machine carries on: the connection still
 * opens, queued sends still drain, the reconnect timer is still installed and later effects in a
 * flush still run. After each sink call the controller checks the slot is still current, so a
 * patch, end or [close] that landed meanwhile stops the stale work.
 */
@InternalAutoMobilePrototypeApi
// One state machine: handlers share its slots and lock, and every collaborator is a seam.
@Suppress("TooManyFunctions", "LongParameterList")
class PrototypeChannelController(
  private val prototypeId: String,
  private val transports: PrototypeChannelTransports,
  private val sink: PrototypeChannelSink,
  private val scope: CoroutineScope,
  private val random: Random = Random.Default,
  private val onError: (Throwable) -> Unit,
  private val newId: () -> String,
) {
  private class Slot(val id: String, val declaration: PrototypeChannelDeclaration) {
    var status = PrototypeChannelStatus.IDLE
    var attempt = 0
    var framesIn = 0L
    var framesDropped = 0L
    var closeCode: Int? = null
    var closeReason: String? = null
    var error: PrototypeChannelError? = null
    var generation = 0L
    var connection: PrototypeChannelConnection? = null
    var lastEventId: String? = null
    var timer: Job? = null
    val queue = ArrayDeque<String>()

    fun snapshot(): JsonObject = buildJsonObject {
      put("status", status.wireValue)
      put("attempt", attempt)
      put("framesIn", framesIn)
      put("framesDropped", framesDropped)
      closeCode?.let { put("closeCode", it) }
      closeReason?.let { put("closeReason", it) }
      error?.let { put("error", it.toJson()) }
    }
  }

  private class Routed(val slot: Slot, val actions: JsonArray, val event: JsonElement)

  private val lock = Mutex()
  private val inbox = Channel<suspend () -> Unit>(Channel.UNLIMITED)
  private val slots = linkedMapOf<String, Slot>()
  private val window = ArrayList<Routed>()
  private val dirty = linkedSetOf<String>()
  private var flush: Job? = null
  private var started = false
  // Set by beginClose() or before close() waits for the lock, so work suspended in a sink call (or
  // still waiting for the lock) sees it at once.
  @Volatile private var closing = false
  // close() has started; a later close() returns at once.
  @Volatile private var closeStarted = false

  init {
    scope.launch { for (work in inbox) lock.withLock { if (!closing) report { work() } } }
  }

  /**
   * Dismissal began. Takes no lock, so it holds at once: work still waiting for the lock (a send
   * queued behind a blocked flush, a transport callback, a timer) does nothing, and [close] then
   * closes the connections.
   */
  fun beginClose() {
    closing = true
  }

  /** The current snapshot of [channel], or null when it is not declared. */
  suspend fun state(channel: String): JsonObject? = lock.withLock { slots[channel]?.snapshot() }

  /**
   * Declares [channels] and, once [show] has run, connects `onShow` ones. A patch keeps unchanged
   * channels as they are, closes removed ones, and reconnects only changed ones that were live.
   */
  suspend fun update(channels: Map<String, PrototypeChannelDeclaration>) = lock.withLock {
    if (closing) return@withLock
    for (id in slots.keys - channels.keys) slots.remove(id)?.let(::abandon)
    for ((id, declaration) in channels) {
      val previous = slots[id]
      if (previous?.declaration == declaration) continue
      val live = previous?.status?.active == true
      previous?.let(::abandon)
      val slot = Slot(id, declaration).also { slots[id] = it }
      report { publish(slot) }
      // A changed channel keeps its state: only live ones reconnect, and only a newly declared
      // channel connects on show.
      val newOnShow = previous == null && started && declaration.connectOnShow
      if (live || newOnShow) report { connect(slot) }
    }
  }

  /** The prototype is shown: connect every `onShow` channel that is still idle. */
  suspend fun show() = lock.withLock {
    if (closing || started) return@withLock
    started = true
    for (slot in slots.values.toList()) {
      if (slot.declaration.connectOnShow && slot.status == PrototypeChannelStatus.IDLE)
        report { connect(slot) }
    }
  }

  /**
   * `realtime.connect`: null once connecting (or already live), else why not. [wanted] is checked
   * under the lock, so a call whose caller gave up while it waited for the lock does nothing.
   */
  suspend fun connect(channel: String, wanted: () -> Boolean = { true }): PrototypeChannelError? =
    lock.withLock {
      val slot = slots[channel] ?: return@withLock unknown(channel)
      if (!wanted()) return@withLock abandoned()
      if (!closing && !slot.status.active) {
        slot.attempt = 0
        connect(slot)
      }
      null
    }

  /** `realtime.disconnect`: closes the connection with 1000 and drops queued sends. */
  suspend fun disconnect(channel: String): PrototypeChannelError? = lock.withLock {
    val slot = slots[channel] ?: return@withLock unknown(channel)
    if (closing || !slot.status.active) return@withLock null
    end(slot)
    slot.connection?.close(NORMAL_CLOSURE, "")
    slot.connection = null
    slot.closeCode = NORMAL_CLOSURE
    slot.closeReason = ""
    setStatus(slot, PrototypeChannelStatus.CLOSED)
    null
  }

  /**
   * `realtime.send`: sent when open, queued while (re)connecting, refused otherwise. [wanted] is
   * checked under the lock, so a caller that gave up while waiting for it sends nothing.
   */
  suspend fun send(
    channel: String,
    data: String,
    wanted: () -> Boolean = { true },
  ): PrototypeChannelError? = lock.withLock {
    val slot = slots[channel] ?: return@withLock unknown(channel)
    if (closing || !wanted()) {
      return@withLock PrototypeChannelError(
        PrototypeChannelError.NETWORK,
        "The channels are closed",
      )
    }
    sendError(slot, data)
  }

  /** Dismiss or reset: closes every connection; the sink hears nothing more. */
  suspend fun close() {
    if (closeStarted) return
    closeStarted = true
    closing = true
    // A later close() returns at once, so this cleanup must finish even if the caller is cancelled
    // while a sink call holds the lock.
    withContext(NonCancellable) {
      lock.withLock {
        flush?.cancel()
        window.clear()
        // One connection whose close throws must not leave the others open.
        slots.values.forEach { slot -> report { abandon(slot) } }
        slots.clear()
      }
      inbox.close()
    }
  }

  private fun sendError(slot: Slot, data: String): PrototypeChannelError? {
    if (slot.declaration.kind != PrototypeChannelKind.WEBSOCKET) {
      return PrototypeChannelError(
        PrototypeChannelError.INVALID_REQUEST,
        "realtime.send requires a websocket channel",
      )
    }
    if (data.toByteArray(Charsets.UTF_8).size > PrototypeChannelLimits.maxSendBytes) {
      return PrototypeChannelError(
        PrototypeChannelError.TOO_LARGE,
        "A send is limited to ${PrototypeChannelLimits.maxSendBytes} bytes",
      )
    }
    return when (slot.status) {
      PrototypeChannelStatus.OPEN ->
        if (slot.connection?.send(data) == true) null
        else PrototypeChannelError(PrototypeChannelError.NETWORK, "The connection is closing")
      PrototypeChannelStatus.CONNECTING,
      PrototypeChannelStatus.RECONNECTING ->
        if (slot.queue.size < MAX_QUEUED_SENDS) null.also { slot.queue.addLast(data) }
        else
          PrototypeChannelError(
            PrototypeChannelError.TOO_MANY_IN_FLIGHT,
            "At most $MAX_QUEUED_SENDS sends can wait for a connection",
          )
      else ->
        PrototypeChannelError(
          PrototypeChannelError.NETWORK,
          "Channel ${slot.id} is not connected",
        )
    }
  }

  private suspend fun connect(slot: Slot) {
    val generation = slot.generation
    slot.closeCode = null
    slot.closeReason = null
    slot.error = null
    report {
      setStatus(
        slot,
        if (slot.attempt == 0) PrototypeChannelStatus.CONNECTING
        else PrototypeChannelStatus.RECONNECTING,
      )
    }
    if (!isCurrent(slot, generation)) return slot.queue.clear()
    open(slot)
  }

  private suspend fun open(slot: Slot) {
    if (closing || slots[slot.id] !== slot) return slot.queue.clear()
    val generation = ++slot.generation
    val declaration = slot.declaration
    val request =
      PrototypeChannelOpenRequest(
        connectionId = newId(),
        prototypeId = prototypeId,
        channel = slot.id,
        kind = declaration.kind,
        url = declaration.url,
        protocols = declaration.protocols,
        headers = declaration.headers,
        lastEventId = slot.lastEventId.takeIf { declaration.kind == PrototypeChannelKind.SSE },
      )
    val connection =
      try {
        transports.forVia(declaration.via).open(request, listener(slot, generation))
      } catch (error: CancellationException) {
        throw error
      } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
        // A transport that cannot start is a failed attempt: it backs off like a dropped one.
        onError(error)
        val reason = PrototypeChannelError(PrototypeChannelError.NETWORK, error.message ?: "$error")
        return ended(slot, null, null, reason)
      }
    slot.connection = connection
  }

  private fun listener(slot: Slot, generation: Long) =
    object : PrototypeChannelListener {
      private fun post(work: suspend () -> Unit) {
        inbox.trySend { if (isCurrent(slot, generation)) work() }
      }

      override fun onOpen(protocol: String?) = post { opened(slot, generation) }

      override fun onFrame(data: String, event: String?, id: String?) = post {
        received(slot, data, event, id)
      }

      override fun onClosed(code: Int?, reason: String?, error: PrototypeChannelError?) = post {
        ended(slot, code, reason, error)
      }
    }

  private suspend fun opened(slot: Slot, generation: Long) {
    report { setStatus(slot, PrototypeChannelStatus.OPEN) }
    if (!isCurrent(slot, generation)) return slot.queue.clear()
    while (slot.queue.isNotEmpty()) slot.connection?.send(slot.queue.removeFirst())
    slot.timer =
      timer(STABLE_OPEN_MS) {
        if (isCurrent(slot, generation) && slot.attempt != 0) {
          slot.attempt = 0
          publish(slot)
        }
      }
    slot.declaration.onOpen?.let { sink.run(slot.id, it, eventOf(slot)) }
  }

  private suspend fun received(slot: Slot, data: String, event: String?, id: String?) {
    val generation = slot.generation
    if (id != null) slot.lastEventId = id
    dirty += slot.id
    if (data.toByteArray(Charsets.UTF_8).size > PrototypeChannelLimits.maxFrameBytes) {
      slot.framesDropped++
      scheduleFlush()
      return
    }
    val decoded = decode(slot, data)
    if (decoded == null) {
      slot.framesDropped++
      scheduleFlush()
      return
    }
    slot.framesIn++
    val delivered = report {
      sink.event(
        FRAME_EVENT,
        buildJsonObject {
          put("channel", slot.id)
          put("data", decoded)
          event?.let { put("event", it) }
          id?.let { put("id", it) }
        },
      )
    }
    if (!isCurrent(slot, generation)) return
    if (delivered) {
      PrototypeChannelRoutes.match(slot.declaration.routes, decoded, event)?.let {
        window += Routed(slot, it, decoded)
      }
    }
    scheduleFlush()
  }

  private fun decode(slot: Slot, data: String): JsonElement? =
    if (!slot.declaration.decodeJson) JsonPrimitive(data)
    else
      try {
        Json.parseToJsonElement(data)
      } catch (_: SerializationException) {
        // A frame that is not JSON on a json channel is counted as dropped, not an error.
        null
      }

  private fun scheduleFlush() {
    if (closing || flush?.isActive == true) return
    flush = timer(PrototypeChannelLimits.flushMs.toLong()) { flushWindow() }
  }

  private suspend fun flushWindow() {
    // A patch or removal since a frame arrived replaced its declaration: drop its actions before
    // coalescing, so a stale write cannot stand in for a live channel's write to the same target.
    val frames = window.filter { slots[it.slot.id] === it.slot }
    window.clear()
    val signatures = frames.map {
      PrototypeChannelCoalescer.coalescingActions(it.actions, it.event)
    }
    // Each effect is applied once: one that throws is reported, never replayed, and the rest run.
    for (index in PrototypeChannelCoalescer.keptIndices(signatures)) {
      if (closing) return
      val routed = frames[index]
      report { sink.run(routed.slot.id, routed.actions, routed.event) }
    }
    val changed = dirty.toList()
    dirty.clear()
    for (slot in changed.mapNotNull { slots[it] }) {
      if (closing) return
      report { publish(slot) }
    }
  }

  private suspend fun ended(
    slot: Slot,
    code: Int?,
    reason: String?,
    error: PrototypeChannelError?,
  ) {
    // A new generation: stale callbacks of this connection, and a stability reset already posted,
    // can no longer touch the slot.
    val generation = ++slot.generation
    slot.timer?.cancel()
    slot.timer = null
    slot.connection = null
    slot.closeCode = code
    slot.closeReason = reason
    slot.error = error
    val callback = if (error != null) slot.declaration.onError else slot.declaration.onClose
    val next = slot.attempt + 1
    val delayMs = slot.declaration.backoffMs(next) { random.nextDouble() }
    if (delayMs == null) {
      slot.queue.clear()
      report {
        setStatus(
          slot,
          if (error != null) PrototypeChannelStatus.ERROR else PrototypeChannelStatus.CLOSED,
        )
      }
    } else {
      slot.attempt = next
      report { setStatus(slot, PrototypeChannelStatus.RECONNECTING) }
    }
    if (!isCurrent(slot, generation)) return slot.queue.clear()
    if (delayMs != null) {
      slot.timer =
        timer(delayMs.toLong()) {
          if (isCurrent(slot, generation)) {
            // This timer is done; a failed open must not cancel it from inside.
            slot.timer = null
            open(slot)
          }
        }
    }
    callback?.let { sink.run(slot.id, it, eventOf(slot)) }
  }

  private suspend fun setStatus(slot: Slot, status: PrototypeChannelStatus) {
    val changed = slot.status != status
    slot.status = status
    publish(slot)
    if (!changed) return
    sink.event(STATUS_EVENT, eventOf(slot))
    slot.declaration.statusKey?.let { key ->
      sink.run(
        slot.id,
        buildJsonArray {
          add(
            buildJsonObject {
              put("type", "setState")
              put("key", key)
              put("value", status.wireValue)
            },
          )
        },
        eventOf(slot),
      )
    }
  }

  private suspend fun publish(slot: Slot) = sink.state(slot.id, slot.snapshot())

  private fun eventOf(slot: Slot): JsonObject =
    JsonObject(mapOf("channel" to JsonPrimitive(slot.id)) + slot.snapshot())

  /** Stops a slot without telling the sink: a newer slot, a patch or a dismiss replaces it. */
  private fun abandon(slot: Slot) {
    end(slot)
    slot.connection?.close(GOING_AWAY, "")
    slot.connection = null
  }

  private fun end(slot: Slot) {
    slot.generation++
    slot.timer?.cancel()
    slot.timer = null
    slot.queue.clear()
    slot.attempt = 0
  }

  private fun timer(millis: Long, work: suspend () -> Unit): Job = scope.launch {
    delay(millis)
    lock.withLock { if (!closing) report { work() } }
  }

  private fun abandoned() =
    PrototypeChannelError(PrototypeChannelError.NETWORK, "The caller stopped waiting")

  private fun isCurrent(slot: Slot, generation: Long): Boolean =
    !closing && slots[slot.id] === slot && slot.generation == generation

  /** Runs [work], handing a failure to [onError]; true when it completed. */
  private inline fun report(work: () -> Unit): Boolean =
    try {
      work()
      true
    } catch (error: CancellationException) {
      throw error
    } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
      // The sink or a transport failed; the state machine must keep running past it.
      onError(error)
      false
    }

  private fun unknown(channel: String) =
    PrototypeChannelError(
      PrototypeChannelError.INVALID_REQUEST,
      "Channel $channel is not declared",
    )

  companion object {
    const val STATUS_EVENT = "realtime.status"
    const val FRAME_EVENT = "realtime.frame"
    const val STABLE_OPEN_MS = 5_000L
    const val MAX_QUEUED_SENDS = 32
    const val NORMAL_CLOSURE = 1000
    const val GOING_AWAY = 1001
  }
}
