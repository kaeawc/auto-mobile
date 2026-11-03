package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeChannelCoalescer
import dev.jasonpearson.automobile.protocol.PrototypeChannelLimits
import dev.jasonpearson.automobile.protocol.PrototypeChannelRoutes
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
}

/**
 * The realtime channel state machine of one prototype (#14269): status, reconnect with full-jitter
 * backoff, the send queue, first-match routing and flush-window coalescing. Transports report on
 * any thread; their callbacks go through one ordered inbox so frames keep their order, and every
 * effect reaches the [sink] under a single lock.
 *
 * Attempts reset once a connection has stayed open for [stableOpenMs], so a server that accepts and
 * drops at once still backs off. Sends made while connecting or reconnecting wait in a bounded
 * queue that is flushed on open and dropped when the channel closes.
 */
@InternalAutoMobilePrototypeApi
@Suppress("TooManyFunctions") // One state machine; the handlers share its slots and lock.
class PrototypeChannelController(
  private val prototypeId: String,
  private val transports: PrototypeChannelTransports,
  private val sink: PrototypeChannelSink,
  private val scope: CoroutineScope,
  private val random: Random = Random.Default,
  private val newId: () -> String,
  private val stableOpenMs: Long = STABLE_OPEN_MS,
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
  private var closed = false

  init {
    scope.launch { for (work in inbox) lock.withLock { if (!closed) work() } }
  }

  /** The current snapshot of [channel], or null when it is not declared. */
  suspend fun state(channel: String): JsonObject? = lock.withLock { slots[channel]?.snapshot() }

  /**
   * Declares [channels] and, once [show] has run, connects `onShow` ones. A patch keeps unchanged
   * channels as they are, closes removed ones, and reconnects only changed ones that were live.
   */
  suspend fun update(channels: Map<String, PrototypeChannelDeclaration>) = lock.withLock {
    if (closed) return@withLock
    for (id in slots.keys - channels.keys) slots.remove(id)?.let(::abandon)
    for ((id, declaration) in channels) {
      val previous = slots[id]
      if (previous?.declaration == declaration) continue
      val live = previous?.status?.active == true
      previous?.let(::abandon)
      val slot = Slot(id, declaration).also { slots[id] = it }
      publish(slot)
      // A changed channel keeps its state: only live ones reconnect, and only a newly declared
      // channel connects on show.
      if (live || (previous == null && started && declaration.connectOnShow)) connect(slot)
    }
  }

  /** The prototype is shown: connect every `onShow` channel that is still idle. */
  suspend fun show() = lock.withLock {
    if (closed || started) return@withLock
    started = true
    for (slot in slots.values) {
      if (slot.declaration.connectOnShow && slot.status == PrototypeChannelStatus.IDLE)
        connect(slot)
    }
  }

  /** `realtime.connect`: null once connecting (or already live), else why not. */
  suspend fun connect(channel: String): PrototypeChannelError? = lock.withLock {
    val slot = slots[channel] ?: return@withLock unknown(channel)
    if (!closed && !slot.status.active) {
      slot.attempt = 0
      connect(slot)
    }
    null
  }

  /** `realtime.disconnect`: closes the connection with 1000 and drops queued sends. */
  suspend fun disconnect(channel: String): PrototypeChannelError? = lock.withLock {
    val slot = slots[channel] ?: return@withLock unknown(channel)
    if (closed || !slot.status.active) return@withLock null
    end(slot)
    slot.connection?.close(NORMAL_CLOSURE, "")
    slot.connection = null
    slot.closeCode = NORMAL_CLOSURE
    slot.closeReason = ""
    setStatus(slot, PrototypeChannelStatus.CLOSED)
    null
  }

  /** `realtime.send`: sent when open, queued while (re)connecting, refused otherwise. */
  suspend fun send(channel: String, data: String): PrototypeChannelError? = lock.withLock {
    val slot = slots[channel] ?: return@withLock unknown(channel)
    sendError(slot, data)
  }

  /** Dismiss or reset: closes every connection; the sink hears nothing more. */
  suspend fun close() {
    lock.withLock {
      if (closed) return@withLock
      closed = true
      flush?.cancel()
      window.clear()
      slots.values.forEach(::abandon)
      slots.clear()
    }
    inbox.close()
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
    slot.closeCode = null
    slot.closeReason = null
    slot.error = null
    setStatus(
      slot,
      if (slot.attempt == 0) PrototypeChannelStatus.CONNECTING
      else PrototypeChannelStatus.RECONNECTING,
    )
    open(slot)
  }

  private fun open(slot: Slot) {
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
    slot.connection = transports.forVia(declaration.via).open(request, listener(slot, generation))
  }

  private fun listener(slot: Slot, generation: Long) =
    object : PrototypeChannelListener {
      private fun post(work: suspend () -> Unit) {
        inbox.trySend { if (slots[slot.id] === slot && slot.generation == generation) work() }
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
    setStatus(slot, PrototypeChannelStatus.OPEN)
    while (slot.queue.isNotEmpty()) slot.connection?.send(slot.queue.removeFirst())
    slot.timer =
      timer(stableOpenMs) {
        if (slot.generation == generation && slot.attempt != 0) {
          slot.attempt = 0
          publish(slot)
        }
      }
    slot.declaration.onOpen?.let { sink.run(slot.id, it, eventOf(slot)) }
  }

  private suspend fun received(slot: Slot, data: String, event: String?, id: String?) {
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
    sink.event(
      FRAME_EVENT,
      buildJsonObject {
        put("channel", slot.id)
        put("data", decoded)
        event?.let { put("event", it) }
        id?.let { put("id", it) }
      },
    )
    PrototypeChannelRoutes.match(slot.declaration.routes, decoded, event)?.let {
      // A fresh array per frame: coalescing keeps frames by identity.
      window += Routed(slot, JsonArray(it), decoded)
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
    if (flush?.isActive == true) return
    flush = timer(PrototypeChannelLimits.flushMs.toLong()) { flushWindow() }
  }

  private suspend fun flushWindow() {
    val frames = window.toList()
    window.clear()
    val kept = PrototypeChannelCoalescer.coalesce(frames.map { it.actions })
    var from = 0
    for (actions in kept) {
      val index = (from until frames.size).first { frames[it].actions === actions }
      from = index + 1
      val routed = frames[index]
      // A patch or removal since the frame arrived replaced its declaration: drop its actions.
      val slot = routed.slot
      if (slots[slot.id] === slot) sink.run(slot.id, routed.actions, routed.event)
    }
    val changed = dirty.toList()
    dirty.clear()
    changed.mapNotNull { slots[it] }.forEach { publish(it) }
  }

  private suspend fun ended(
    slot: Slot,
    code: Int?,
    reason: String?,
    error: PrototypeChannelError?,
  ) {
    slot.timer?.cancel()
    slot.connection = null
    slot.closeCode = code
    slot.closeReason = reason
    slot.error = error
    val callback = if (error != null) slot.declaration.onError else slot.declaration.onClose
    val next = slot.attempt + 1
    val delayMs = slot.declaration.backoffMs(next) { random.nextDouble() }
    if (delayMs == null) {
      slot.queue.clear()
      setStatus(
        slot,
        if (error != null) PrototypeChannelStatus.ERROR else PrototypeChannelStatus.CLOSED,
      )
    } else {
      slot.attempt = next
      setStatus(slot, PrototypeChannelStatus.RECONNECTING)
      val generation = slot.generation
      slot.timer = timer(delayMs.toLong()) { if (slot.generation == generation) open(slot) }
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
    lock.withLock { if (!closed) work() }
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
