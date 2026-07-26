package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * One device-control tap, snapshotted at click time (issue #3347). Carries the tap target — client,
 * platform, device id — captured atomically on the UI thread, plus the [token] the error-ordering
 * gate ([ControlTapErrorGate]) issued for this attempt.
 */
data class DeviceControlTapCommand(
  val point: DevicePoint,
  val client: AutoMobileClient?,
  val platform: String,
  val deviceId: String,
  val token: Long,
)

/**
 * Serializes device-control taps so their daemon requests execute in **click order** (issue #3347).
 *
 * Each click launched its own `Dispatchers.IO` coroutine before, so two rapid taps could connect
 * and write their socket requests out of order — the daemon's per-device queue preserves arrival
 * order, not click order, so a tap sequence could execute reversed. A
 * [kotlinx.coroutines.sync.Mutex] would not fix this: with independent launches, which coroutine
 * acquires the lock first is scheduling-dependent, not click-ordered. A single-consumer FIFO
 * channel does: taps are enqueued synchronously on the UI thread in click order and drained one at
 * a time, so each [handle] completes before the next begins.
 *
 * The queue is **bounded** ([TAP_QUEUE_CAPACITY]). An unbounded queue would retain every rapid
 * click and its captured [AutoMobileClient] while a slow/stalled daemon blocks the sole consumer,
 * and would later fire a large aged backlog. On overflow [enqueue] rejects the newest tap (closing
 * its captured client) and returns false so the caller can surface an overload error. [reset] drops
 * the queued backlog (closing each pending client) when the control context changes, so a
 * stalled/aged tap can't fire after a device/mode/stream change.
 *
 * Its only consumer is `AutoMobileContent`; it is a deliberate testability seam extracted from that
 * Compose host so the ordering/back-pressure guarantees are Compose-free and unit-testable. Do not
 * inline it.
 *
 * @param scope the coroutine scope the single consumer runs in (cancelled with the composition).
 * @param handle processes one command to completion — forwards the tap, closes its client, and
 *   publishes any error. The next command waits until it returns, which is what preserves order.
 */
class DeviceControlTapDispatcher(
  scope: CoroutineScope,
  private val handle: suspend (DeviceControlTapCommand) -> Unit,
) {
  private val commands = Channel<DeviceControlTapCommand>(TAP_QUEUE_CAPACITY)

  init {
    scope.launch {
      for (command in commands) {
        handle(command)
      }
    }
  }

  /**
   * Enqueue a tap in click order. Non-blocking; safe to call from the UI thread. Returns true when
   * accepted, or false when the bounded queue is full — in which case the newest tap is rejected
   * and its captured client is closed so it does not leak. The caller should surface an overload
   * error.
   */
  fun enqueue(command: DeviceControlTapCommand): Boolean {
    if (commands.trySend(command).isSuccess) return true
    // Full (or closed): reject the newest and close its client rather than block or leak.
    command.client?.close()
    return false
  }

  /**
   * Drop every queued-but-not-yet-started tap, closing each pending command's captured client, so a
   * stalled/aged backlog can't actuate a device after the control context changes. The one command
   * already in flight in [handle] is not interrupted (it targets its own snapshotted device id);
   * only the pending queue is cleared. Safe to call from the UI thread.
   */
  fun reset() {
    while (true) {
      val command = commands.tryReceive().getOrNull() ?: break
      command.client?.close()
    }
  }

  companion object {
    /**
     * Bounded queue depth. Small: a human cannot out-click a working daemon by more than a few
     * taps, and a stalled daemon must not let the backlog grow without bound.
     */
    const val TAP_QUEUE_CAPACITY: Int = 16
  }
}
