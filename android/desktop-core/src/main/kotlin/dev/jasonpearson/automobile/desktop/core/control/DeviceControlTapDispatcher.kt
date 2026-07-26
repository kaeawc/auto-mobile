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
 * order, not click order, so a tap sequence could execute reversed. A [Mutex] would not fix this:
 * with independent launches, which coroutine acquires the lock first is scheduling-dependent, not
 * click-ordered. A single-consumer FIFO channel does: taps are enqueued synchronously on the UI
 * thread in click order and drained one at a time, so each [handle] completes before the next
 * begins.
 *
 * Its only consumer is `AutoMobileContent`; it is a deliberate testability seam extracted from that
 * Compose host so the ordering guarantee is Compose-free and unit-testable. Do not inline it.
 *
 * @param scope the coroutine scope the single consumer runs in (cancelled with the composition).
 * @param handle processes one command to completion — forwards the tap, closes its client, and
 *   publishes any error. The next command waits until it returns, which is what preserves order.
 */
class DeviceControlTapDispatcher(
  scope: CoroutineScope,
  private val handle: suspend (DeviceControlTapCommand) -> Unit,
) {
  // UNLIMITED so the UI-thread enqueue never suspends or drops a tap; taps are rare relative to the
  // buffer.
  private val commands = Channel<DeviceControlTapCommand>(Channel.UNLIMITED)

  init {
    scope.launch {
      for (command in commands) {
        handle(command)
      }
    }
  }

  /** Enqueue a tap in click order. Non-blocking; safe to call from the UI thread. */
  fun enqueue(command: DeviceControlTapCommand) {
    commands.trySend(command)
  }
}
