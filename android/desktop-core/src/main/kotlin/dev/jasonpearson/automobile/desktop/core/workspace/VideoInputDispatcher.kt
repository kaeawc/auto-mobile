package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.control.DeviceGestureStreamHandle
import dev.jasonpearson.automobile.desktop.core.control.GestureStreamEvent
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.logging.LoggerFactory
import dev.jasonpearson.automobile.desktop.domain.DeviceDragDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceDragGesturePolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardInputPolicy
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private val LOG = LoggerFactory.getLogger("VideoInputDispatcher")

/**
 * Frame-identity-free input dispatch for the workspace VIDEO pane (the "disconnect the video frame
 * from the input" path).
 *
 * The layout inspector routes taps through
 * [dev.jasonpearson.automobile.desktop.core.control.DeviceControlSession], whose whole job is to
 * keep the *clicked pixels coherent with the coordinate mapping*: it pairs a screenshot+hierarchy
 * by capture identity, tracks coordinate-space/rotation flips, and sends each tap tagged with the
 * snapshot's `frameContext` so the daemon can reject one mapped through a frame the device has
 * already moved off of. That is exactly right when the user is clicking the observation screenshot.
 *
 * The video pane is different: the user clicks the **live H.264 video**, not the observation
 * screenshot. The frame the tap was "mapped through" is not a capture the daemon can validate — it
 * is just whatever video frame was on screen — so tagging the tap with an observation
 * `frameContext` only invites a stale-context rejection. On a static screen the daemon dedupes
 * hierarchy updates, that context ages, and the session disarms the pane ("one tap works, then it
 * freezes"). This dispatcher removes that coupling: a tap needs only the device geometry to map
 * through (supplied by a retained snapshot, purely for its width/height/rotation) and a client to
 * send it. It sends with **no frameContext**, so the daemon never rejects it as stale, and the pane
 * never wedges.
 *
 * Serialized through a fair [Mutex] so rapid taps reach the device in gesture order; each action
 * uses a FRESH client, closed after the call, matching the daemon-action pattern elsewhere. The
 * blocking daemon call runs on a DEDICATED, always-warm dispatch thread, never the UI thread.
 *
 * A tap must fire the instant it arrives. Dispatching onto the shared elastic [Dispatchers.IO] pool
 * paid a thread-wakeup penalty — the pool parks its threads when idle, so a tap after a quiet
 * moment waited ~a dozen ms just for a worker to un-park (this showed up as `queue` in the latency
 * spans, while the socket round-trip itself measured ~0ms). A single daemon thread kept alive for
 * the pane never parks, so the send starts immediately; being single-threaded it also serializes
 * taps FIFO on its own, and the [Mutex] then only guards against a caller injecting a
 * multi-threaded dispatcher.
 *
 * @param clientProvider mints a fresh [AutoMobileClient] per action (never the shared long-lived
 *   client); null means nothing is connected and the action is dropped silently.
 * @param platform daemon platform string for [deviceId] ("android" / "ios").
 * @param tracer perf-span sink: [InteractionLatencyTracer.dispatching] is stamped at the actual
 *   send (after the mutex wait and client mint, so those count as queue time, not dispatch time)
 *   and [InteractionLatencyTracer.acked] when the daemon call returns.
 * @param ioDispatcher test seam: inject a deterministic dispatcher. Null (production) owns a
 *   dedicated single-thread executor, shut down when [scope] completes so panes don't leak threads.
 */
class VideoInputDispatcher(
  private val scope: CoroutineScope,
  private val clientProvider: () -> AutoMobileClient?,
  private val platform: () -> String,
  private val deviceId: String,
  private val tracer: InteractionLatencyTracer,
  ioDispatcher: CoroutineDispatcher? = null,
  /**
   * Feature flag for streaming (real-time) drag input on the video pane (issue: streaming gesture
   * input). Off by default: [beginGestureStream] returns null and a drag stays an atomic [swipe] on
   * release. When on, a drag streams live and — if the daemon/runner cannot stream — falls back to
   * the same atomic swipe, so the pane behaves identically either way.
   */
  private val streamingEnabled: Boolean = false,
) {
  private val injectedDispatcher: CoroutineDispatcher? = ioDispatcher

  /** Monotonic id per streamed gesture, correlating its start/move/end frames on the wire. */
  private val gestureSeq = AtomicLong(0L)

  // The warm dispatch thread is created LAZILY — on the first real dispatch, and only when no
  // dispatcher was injected. A pane that is never driven (an unfocused farm pane whose control is
  // gated off) therefore holds NO dispatch thread at all. [reset] retires it again when the pane
  // deactivates, and pane disposal (scope completion) retires it for good. All access is on the
  // Compose main thread (dispatch + reset), so the plain read-then-create needs no extra lock.
  @Volatile private var ownedExecutor: ExecutorService? = null
  @Volatile private var ownedDispatcher: CoroutineDispatcher? = null

  init {
    scope.coroutineContext.job.invokeOnCompletion { retireExecutor() }
  }

  private fun dispatchDispatcher(): CoroutineDispatcher {
    injectedDispatcher?.let {
      return it
    }
    ownedDispatcher?.let {
      return it
    }
    val executor = Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "video-input-dispatch-$deviceId").apply { isDaemon = true }
    }
    val dispatcher = executor.asCoroutineDispatcher()
    ownedExecutor = executor
    ownedDispatcher = dispatcher
    return dispatcher
  }

  private fun retireExecutor() {
    // shutdown() (not shutdownNow) lets any queued coroutine drain — generation-stale ones drop.
    ownedExecutor?.shutdown()
    ownedExecutor = null
    ownedDispatcher = null
  }

  // Fair mutex: suspended waiters acquire in suspension order, so serialized taps stay FIFO.
  private val mutex = Mutex()

  // Deactivation token. Each dispatch captures the current value; [reset] increments it. A
  // coroutine
  // whose captured generation no longer matches was queued before a reset and is DROPPED — even if
  // a
  // later reactivating input has since arrived. A per-dispatch token (not a shared flag a
  // reactivation could clear out from under the stale work) is what makes `tap(old); reset();
  // tap(new)` drop only `old`.
  private val activeGeneration = AtomicLong(0L)

  // Backlog bound. Each dispatch launches a coroutine that blocks on the mutex + daemon send; if
  // the
  // daemon stalls (or is mid-reconnect) those pile up, and on recovery a whole backlog of now-stale
  // inputs would replay onto the device at once. Cap the in-flight+queued count and DROP once full:
  // for best-effort live input a dropped tap during a stall is far better than a burst of stale
  // ones
  // firing seconds later. Generous enough that normal fast interaction never trips it.
  private val pendingDispatches = AtomicInteger(0)

  /**
   * Send a tap at the device-mapped [point]. Returns true only when the tap was actually enqueued
   * for dispatch. Out-of-bounds points are dropped (never tapped) and return false per the
   * coordinate-mapping contract; a tap shed by a full dispatch backlog also returns false, so the
   * caller withholds success feedback for a tap that never left.
   */
  fun tap(point: DevicePoint): Boolean {
    if (!point.inBounds) return false
    flushPendingText()
    // Return the ENQUEUE result: false when the backlog shed this tap, so the pane withholds the
    // success touch pulse for an input that never left (issue #3352 feedback contract).
    return dispatch { client, platformName ->
      client.inputTap(
        x = point.x.toDouble(),
        y = point.y.toDouble(),
        platform = platformName,
        deviceId = deviceId,
        frameContext = null,
      )
    }
  }

  /**
   * Send a drag from [start] to [end], both already mapped through [snapshot]'s geometry. The pure
   * [DeviceDragGesturePolicy] decides whether the movement is a swipe at all (a sub-threshold
   * jitter is not) and clamps an endpoint that ran off the frame; a non-swipe sends nothing.
   * [gestureDurationMs] is how long the host flick took, which the policy turns into the swipe's
   * velocity so a fast flick lands as a strong fling.
   */
  fun swipe(
    snapshot: DeviceFrameSnapshot,
    start: DevicePoint,
    end: DevicePoint,
    gestureDurationMs: Int,
  ) {
    val decision =
      DeviceDragGesturePolicy.evaluate(
        start = start,
        end = end,
        deviceWidth = snapshot.deviceWidth,
        deviceHeight = snapshot.deviceHeight,
        coordinateSpace = snapshot.coordinateSpace,
        nativeScale = snapshot.nativeScale,
        gestureDurationMs = gestureDurationMs,
      )
    if (decision !is DeviceDragDecision.Swipe) return
    flushPendingText()
    dispatch { client, platformName ->
      client.inputSwipe(
        startX = decision.start.x.toDouble(),
        startY = decision.start.y.toDouble(),
        endX = decision.end.x.toDouble(),
        endY = decision.end.y.toDouble(),
        platform = platformName,
        deviceId = deviceId,
        durationMs = decision.durationMs,
        frameContext = null,
      )
    }
  }

  /**
   * Begin a streamed (real-time) drag from [start] (mapped through [snapshot]). Returns a handle
   * the pane feeds incremental moves and the release to, or null when streaming is off, the start
   * is off-screen, or the backlog is full — in which case the pane falls back to the atomic [swipe]
   * on release. Like the atomic path this is frame-identity-free (no `frameContext`).
   *
   * The drag holds the warm dispatch thread's mutex for its whole lifetime — the same single-slot
   * serialization taps use — so a mid-drag tap simply queues until release. When the client cannot
   * stream, the consumer drains the events and dispatches one atomic swipe, so the pane emits the
   * same start/move/end regardless of daemon/runner support.
   */
  fun beginGestureStream(
    snapshot: DeviceFrameSnapshot,
    start: DevicePoint,
  ): DeviceGestureStreamHandle? {
    if (!streamingEnabled) return null
    if (!start.inBounds) return null
    flushPendingText()
    val events = Channel<GestureStreamEvent>(Channel.UNLIMITED)
    val gestureId = "gesture-${gestureSeq.incrementAndGet()}"
    val platformName = platform()
    val generation = activeGeneration.get()
    if (pendingDispatches.incrementAndGet() > MAX_PENDING_DISPATCHES) {
      pendingDispatches.decrementAndGet()
      LOG.warn("dropping video gesture stream for $deviceId: dispatch backlog full")
      events.close()
      return null
    }
    scope.launch(dispatchDispatcher()) {
      try {
        mutex.withLock {
          if (generation != activeGeneration.get()) {
            drainGestureEvents(events)
            return@withLock
          }
          val client = clientProvider()
          if (client == null) {
            drainGestureEvents(events)
            return@withLock
          }
          streamOrFallback(client, platformName, snapshot, gestureId, start, events)
        }
      } finally {
        pendingDispatches.decrementAndGet()
      }
    }
    return DeviceGestureStreamHandle(events)
  }

  private suspend fun streamOrFallback(
    client: AutoMobileClient,
    platformName: String,
    snapshot: DeviceFrameSnapshot,
    gestureId: String,
    start: DevicePoint,
    events: Channel<GestureStreamEvent>,
  ) {
    val stream = client.openGestureStream(platformName, deviceId)
    if (stream == null) {
      fallbackAtomicSwipe(client, platformName, snapshot, start, events)
      return
    }
    tracer.dispatching(deviceId)
    try {
      stream.start(gestureId, start.x.toDouble(), start.y.toDouble())
      for (event in events) {
        when (event) {
          is GestureStreamEvent.Move ->
            stream.move(gestureId, event.point.x.toDouble(), event.point.y.toDouble())
          is GestureStreamEvent.End -> {
            stream.end(gestureId, event.point.x.toDouble(), event.point.y.toDouble(), event.cancel)
            break
          }
        }
      }
      tracer.acked(deviceId)
    } finally {
      stream.close()
    }
  }

  private suspend fun fallbackAtomicSwipe(
    client: AutoMobileClient,
    platformName: String,
    snapshot: DeviceFrameSnapshot,
    start: DevicePoint,
    events: Channel<GestureStreamEvent>,
  ) {
    for (event in events) {
      if (event is GestureStreamEvent.End) {
        if (event.cancel) return
        val decision =
          DeviceDragGesturePolicy.evaluate(
            start = start,
            end = event.point,
            deviceWidth = snapshot.deviceWidth,
            deviceHeight = snapshot.deviceHeight,
            coordinateSpace = snapshot.coordinateSpace,
            nativeScale = snapshot.nativeScale,
          )
        if (decision is DeviceDragDecision.Swipe) {
          client.inputSwipe(
            startX = decision.start.x.toDouble(),
            startY = decision.start.y.toDouble(),
            endX = decision.end.x.toDouble(),
            endY = decision.end.y.toDouble(),
            platform = platformName,
            deviceId = deviceId,
            durationMs = decision.durationMs,
            frameContext = null,
          )
        }
        return
      }
    }
  }

  private suspend fun drainGestureEvents(events: Channel<GestureStreamEvent>) {
    for (event in events) {
      if (event is GestureStreamEvent.End) break
    }
  }

  /**
   * Forward [stroke] per the pure [DeviceKeyboardInputPolicy]: a device-meaningful key becomes one
   * button/key press, a printable character one append-typed text, anything else nothing. Returns
   * whether the caller should CONSUME the key (false lets an un-forwarded chord reach the host).
   */
  fun key(stroke: DeviceKeyStroke): Boolean {
    when (val decision = DeviceKeyboardInputPolicy.evaluate(stroke = stroke)) {
      is DeviceKeyboardDecision.PressButton -> {
        flushPendingText()
        dispatch { client, platformName ->
          client.inputPressButton(
            button = decision.button,
            platform = platformName,
            deviceId = deviceId,
            frameContext = null,
          )
        }
      }
      is DeviceKeyboardDecision.SendKey -> {
        flushPendingText()
        dispatch { client, platformName ->
          client.inputKey(
            key = decision.key,
            platform = platformName,
            deviceId = deviceId,
            frameContext = null,
          )
        }
      }
      // Printable characters are COALESCED, not sent one round-trip each. See [bufferText].
      is DeviceKeyboardDecision.TypeText -> bufferText(decision.text)
      is DeviceKeyboardDecision.Ignored -> return false
    }
    return true
  }

  // Coalesce printable typing. Each keystroke is otherwise its own daemon round-trip AND its own
  // on-device `adb` append subprocess, so fast typing crawled and felt laggy. Buffer characters
  // that
  // arrive within a short window and send them as ONE `inputTypeText` — collapsing a burst's N
  // round-trips (and the daemon's per-call injection overhead) to one. Any non-text input (a device
  // key, tap, swipe, or button) flushes the pending text FIRST via [flushPendingText], so the
  // device
  // sees the exact order the user produced (typed text, THEN the key/tap).
  private val textLock = Any()
  private val pendingText = StringBuilder() // guarded by textLock
  private var textFlushScheduled = false // guarded by textLock

  private fun bufferText(text: String) {
    synchronized(textLock) {
      pendingText.append(text)
      if (textFlushScheduled) return
      textFlushScheduled = true
    }
    scope.launch {
      delay(TEXT_FLUSH_WINDOW_MS)
      flushPendingText()
    }
  }

  private fun flushPendingText() {
    val batch =
      synchronized(textLock) {
        textFlushScheduled = false
        if (pendingText.isEmpty()) return
        pendingText.toString().also { pendingText.setLength(0) }
      }
    dispatch { client, platformName ->
      client.inputTypeText(
        text = batch,
        platform = platformName,
        deviceId = deviceId,
        // Always request append (real key events) rather than the daemon's default ACTION_SET_TEXT,
        // which REPLACES the field — mirroring one keystroke at a time under SET_TEXT would leave
        // only the last character and wipe existing text. This matches DeviceControlInputForwarder;
        // the keyboard policy is the gate that refuses TypeText for a platform lacking append
        // (issue #3351), so this call only fires where append is valid.
        append = true,
        frameContext = null,
      )
    }
  }

  /**
   * Press a device/navigation button by its daemon name (Back/Home/Recent), frame-identity-free.
   */
  fun pressButton(button: String) {
    flushPendingText()
    dispatch { client, platformName ->
      client.inputPressButton(
        button = button,
        platform = platformName,
        deviceId = deviceId,
        frameContext = null,
      )
    }
  }

  /**
   * Deactivate the dispatcher when its pane loses focus/control. Drops queued and buffered input so
   * a later state can't replay it at the no-longer-focused device, and retires the warm dispatch
   * thread so an idle farm pane holds none. Fully reusable — the next input re-activates it and
   * re-creates the thread on demand. Called on the Compose main thread (a focus-gate transition).
   */
  fun reset() {
    activeGeneration.incrementAndGet()
    synchronized(textLock) {
      pendingText.setLength(0)
      textFlushScheduled = false
    }
    retireExecutor()
  }

  /**
   * Returns whether the input was ENQUEUED for dispatch. False means it was shed synchronously
   * because the backlog is full — the caller must not report success (e.g. draw a touch pulse) for
   * an input that never left. A true return is only the enqueue; an async provider-null or
   * daemon-rejection is logged, not reflected in the return.
   */
  private inline fun dispatch(
    crossinline send: (AutoMobileClient, String) -> InputActionResult
  ): Boolean {
    val platformName = platform()
    // Capture the deactivation generation at enqueue; the coroutine drops if [reset] bumped it
    // since
    // (the next input after a reset re-creates the warm thread on demand via [dispatchDispatcher]).
    val generation = activeGeneration.get()
    // Shed load before launching once the backlog is full (see [pendingDispatches]).
    if (pendingDispatches.incrementAndGet() > MAX_PENDING_DISPATCHES) {
      pendingDispatches.decrementAndGet()
      LOG.warn(
        "dropping video input for $deviceId: dispatch backlog full ($MAX_PENDING_DISPATCHES)"
      )
      return false
    }
    // Launch DIRECTLY on the dedicated warm dispatch thread, not on [scope]'s (Compose Main,
    // frame-aligned) dispatcher and not on the elastic IO pool. The blocking send runs off the UI
    // thread and starts immediately — no frame-aligned hop, no IO-pool thread-wakeup penalty.
    scope.launch(dispatchDispatcher()) {
      try {
        mutex.withLock {
          // Deactivated (reset) after this was queued (pane lost focus): drop it rather than tap a
          // device the user has moved away from — even if a later input has since reactivated us.
          if (generation != activeGeneration.get()) return@withLock
          val client = clientProvider() ?: return@withLock
          // Stamp the dispatch span at the ACTUAL send, not at enqueue: the mutex wait and client
          // mint belong to queueMs, and dispatchMs must isolate the daemon round-trip so the perf
          // breakdown attributes latency to the right stage. A no-op unless a tap is pending.
          tracer.dispatching(deviceId)
          try {
            val result = send(client, platformName)
            if (result.success) {
              // Only a send that actually succeeded is an ack: stamping this after a thrown or
              // rejected send would record a failed round-trip as acknowledged and corrupt the
              // latency breakdown.
              tracer.acked(deviceId)
            } else {
              // The daemon accepted the request but reported the input failed (e.g. a transport
              // that does not support direct input helpers). Surface it instead of silently
              // treating it as delivered.
              LOG.warn("video input rejected for $deviceId: ${result.error ?: result.action}")
            }
          } catch (error: Exception) {
            // Best-effort input: a failed tap must never crash the pane. Log and drop — the video
            // keeps streaming and the next tap is independent.
            LOG.warn("video input dispatch failed for $deviceId", error)
          } finally {
            client.close()
          }
        }
      } finally {
        pendingDispatches.decrementAndGet()
      }
    }
    return true
  }

  private companion object {
    // Max in-flight + queued dispatches before new input is dropped rather than backlogged. Sized
    // well above any burst a human produces so it only ever trips when the daemon has stalled.
    const val MAX_PENDING_DISPATCHES = 64

    // How long printable keystrokes are gathered before the batch is sent. Short enough that typed
    // text still appears near-instantly (a burst lands within this window of the first key), long
    // enough to fold a fast typist's run into a single round-trip.
    const val TEXT_FLUSH_WINDOW_MS = 40L
  }
}
