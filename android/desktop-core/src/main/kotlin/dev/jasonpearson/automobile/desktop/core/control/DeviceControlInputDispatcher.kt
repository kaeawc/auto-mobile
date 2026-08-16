package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DeviceFrameSnapshot
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * One device-control input, bound to the frame it was gestured on (issues #3347, #3348, #3350).
 *
 * [snapshot] is the atomic [DeviceFrameSnapshot] the view mapped this input's coordinates through,
 * captured together with them on the UI thread. It is the authority for the target device, so a
 * snapshot swap between gesture and dispatch cannot redirect this input or rescale its coordinates.
 * [token] is the error-ordering claim [DeviceControlSession] issued for this attempt.
 *
 * Sealed rather than one command with a nullable end point: every input action added to this seam
 * ([Tap], [Swipe], and keyboard/text/button — [PressButton], [TypeText], [SendKey] — under #3351)
 * carries the same routing fields and travels the same queue, but its payload is its own. A shared
 * shape would make "a tap is a swipe with a null end" representable, which the forwarder would then
 * have to re-derive at dispatch time.
 */
sealed interface DeviceControlInputCommand {
  /** The daemon client this input was captured against; null when nothing was connected. */
  val client: AutoMobileClient?

  /** The daemon platform string ("android" / "ios") read at enqueue time. */
  val platform: String

  /** The frame this input was mapped through; the authority for the target device. */
  val snapshot: DeviceFrameSnapshot

  /** The error-ordering claim for this attempt. */
  val token: Long

  /** A single-point tap at [point] (issue #3347). */
  data class Tap(
    val point: DevicePoint,
    override val client: AutoMobileClient?,
    override val platform: String,
    override val snapshot: DeviceFrameSnapshot,
    override val token: Long,
  ) : DeviceControlInputCommand

  /**
   * A swipe from [start] to [end] over [durationMs] (issue #3350). Both endpoints were mapped
   * through the same [snapshot], so the gesture cannot be half-mapped through two frames.
   */
  data class Swipe(
    val start: DevicePoint,
    val end: DevicePoint,
    val durationMs: Int,
    override val client: AutoMobileClient?,
    override val platform: String,
    override val snapshot: DeviceFrameSnapshot,
    override val token: Long,
  ) : DeviceControlInputCommand

  /**
   * A device/navigation button press (issue #3351), e.g. `back`. [button] is already in the
   * daemon's `input/pressButton` vocabulary — the keyboard policy resolved it before enqueue, so
   * nothing downstream re-derives a key mapping.
   */
  data class PressButton(
    val button: String,
    override val client: AutoMobileClient?,
    override val platform: String,
    override val snapshot: DeviceFrameSnapshot,
    override val token: Long,
  ) : DeviceControlInputCommand

  /**
   * Printable text to type on the device (issue #3351). One keystroke produces one character, so
   * [text] is normally a single character; the field is a String because `input/typeText` takes one
   * and a client is free to batch.
   */
  data class TypeText(
    val text: String,
    override val client: AutoMobileClient?,
    override val platform: String,
    override val snapshot: DeviceFrameSnapshot,
    override val token: Long,
  ) : DeviceControlInputCommand

  /**
   * A discrete device key event (issue #3351), e.g. `enter`. [key] is already in the daemon's
   * `input/key` vocabulary.
   */
  data class SendKey(
    val key: String,
    override val client: AutoMobileClient?,
    override val platform: String,
    override val snapshot: DeviceFrameSnapshot,
    override val token: Long,
  ) : DeviceControlInputCommand

  /**
   * A live, streamed drag (issue: streaming gesture input). Unlike [Swipe] — one atomic request on
   * release — this holds ONE queue slot for the whole drag: [start] is the finger-down point, and
   * incremental moves and the release arrive over [events] as the user drags, so the device tracks
   * the pointer in real time. All points are mapped through the one [snapshot], like [Swipe].
   *
   * Occupying the single FIFO slot for the drag's lifetime is deliberate: taps/keys made mid-drag
   * queue behind it and run after release, which is the correct ordering (you cannot tap during a
   * drag). When the client cannot stream, the consumer drains [events] and falls back to one atomic
   * swipe, so the caller emits the same start/move/end regardless of daemon/runner support.
   */
  data class StreamGesture(
    val start: DevicePoint,
    val gestureId: String,
    val events: Channel<GestureStreamEvent>,
    override val client: AutoMobileClient?,
    override val platform: String,
    override val snapshot: DeviceFrameSnapshot,
    override val token: Long,
  ) : DeviceControlInputCommand
}

/**
 * One frame fed to an in-flight [DeviceControlInputCommand.StreamGesture] as the drag progresses.
 */
sealed interface GestureStreamEvent {
  /** The pointer moved to [point] (already mapped through the gesture's snapshot). */
  data class Move(val point: DevicePoint) : GestureStreamEvent

  /** The pointer was released at [point], or the drag was [cancel]led (lift in place). Terminal. */
  data class End(val point: DevicePoint, val cancel: Boolean) : GestureStreamEvent
}

/**
 * The view's handle to one in-flight streamed drag, returned by
 * `DeviceControlSession.beginGestureStream`. The view maps each pointer sample through the pinned
 * snapshot and calls [move]; on release it calls [end], which closes the stream. Fire-and-forget
 * (`trySend` onto an unbounded channel): the caller never blocks the UI thread, and the desktop
 * client's throttle keeps the volume bounded. Calling [move] after [end] is a harmless no-op on the
 * closed channel.
 */
class DeviceGestureStreamHandle
internal constructor(private val events: Channel<GestureStreamEvent>) {
  fun move(point: DevicePoint) {
    events.trySend(GestureStreamEvent.Move(point))
  }

  fun end(point: DevicePoint, cancel: Boolean = false) {
    events.trySend(GestureStreamEvent.End(point, cancel))
    events.close()
  }
}

/**
 * Serializes device-control inputs so their daemon requests execute in **gesture order**
 * (issue #3347, extended to swipes in #3350).
 *
 * Each click launched its own `Dispatchers.IO` coroutine before, so two rapid taps could connect
 * and write their socket requests out of order — the daemon's per-device queue preserves arrival
 * order, not gesture order, so an input sequence could execute reversed. A
 * [kotlinx.coroutines.sync.Mutex] would not fix this: with independent launches, which coroutine
 * acquires the lock first is scheduling-dependent, not gesture-ordered. A single-consumer FIFO
 * channel does: inputs are enqueued synchronously on the UI thread in gesture order and drained one
 * at a time, so each [handle] completes before the next begins. Taps, swipes, button presses, typed
 * text and discrete keys all share this ONE queue, which is what makes a tap-then-type sequence
 * reach the device in the order the user made it; a second queue for any of them would reintroduce
 * exactly the race this type removed.
 *
 * The queue is **bounded** ([INPUT_QUEUE_CAPACITY]). An unbounded queue would retain every rapid
 * gesture and its captured [AutoMobileClient] while a slow/stalled daemon blocks the sole consumer,
 * and would later fire a large aged backlog. On overflow [enqueue] rejects the newest input
 * (closing its captured client) and returns false so the caller can surface an overload error.
 * [reset] drops the queued backlog (closing each pending client) when the control context changes,
 * so a stalled/aged input can't fire after a device/mode/stream change.
 *
 * Its only consumer is `DeviceControlSession`; it is a deliberate testability seam extracted from
 * that session so the ordering/back-pressure guarantees are Compose-free and unit-testable. Do not
 * inline it.
 *
 * @param scope the coroutine scope the single consumer runs in (cancelled with the composition).
 * @param handle processes one command to completion — forwards the input, closes its client, and
 *   publishes any error. The next command waits until it returns, which is what preserves order.
 */
class DeviceControlInputDispatcher(
  scope: CoroutineScope,
  private val handle: suspend (DeviceControlInputCommand) -> Unit,
) {
  private val commands = Channel<DeviceControlInputCommand>(INPUT_QUEUE_CAPACITY)

  init {
    scope.launch {
      for (command in commands) {
        handle(command)
      }
    }
  }

  /**
   * Enqueue an input in gesture order. Non-blocking; safe to call from the UI thread. Returns true
   * when accepted, or false when the bounded queue is full — in which case the newest input is
   * rejected and its captured client is closed so it does not leak. The caller should surface an
   * overload error.
   */
  fun enqueue(command: DeviceControlInputCommand): Boolean {
    if (commands.trySend(command).isSuccess) return true
    // Full (or closed): reject the newest and close its client rather than block or leak.
    command.client?.close()
    return false
  }

  /**
   * Drop every queued-but-not-yet-started input, closing each pending command's captured client, so
   * a stalled/aged backlog can't actuate a device after the control context changes. The one
   * command already in flight in [handle] is not interrupted (it targets its own snapshotted device
   * id); only the pending queue is cleared. Safe to call from the UI thread.
   */
  fun reset() {
    while (true) {
      val command = commands.tryReceive().getOrNull() ?: break
      command.client?.close()
    }
  }

  /**
   * Drop pending inputs bound to [frameContext], preserving inputs the user made through a newer
   * paired frame. A stale-context response proves only its own snapshot unsafe; clearing every
   * pending command here would silently discard an already queued gesture for a newer snapshot.
   *
   * Like [reset], this runs on the session's UI context. The consumer is suspended while its
   * current command publishes the rejection, so retained commands can be put back in FIFO order
   * before it reads the queue again.
   */
  fun discardFrameContext(frameContext: String): Long? {
    val retained = mutableListOf<DeviceControlInputCommand>()
    var newestDiscardedToken: Long? = null
    while (true) {
      val command = commands.tryReceive().getOrNull() ?: break
      if (command.snapshot.frameContext == frameContext) {
        command.client?.close()
        newestDiscardedToken = maxOf(newestDiscardedToken ?: Long.MIN_VALUE, command.token)
      } else {
        retained += command
      }
    }
    retained.forEach { command ->
      check(commands.trySend(command).isSuccess) {
        "A retained device-control command did not fit back into its drained queue"
      }
    }
    return newestDiscardedToken
  }

  companion object {
    /**
     * Bounded queue depth. Small: a human cannot out-gesture a working daemon by more than a few
     * inputs, and a stalled daemon must not let the backlog grow without bound.
     */
    const val INPUT_QUEUE_CAPACITY: Int = 16
  }
}
