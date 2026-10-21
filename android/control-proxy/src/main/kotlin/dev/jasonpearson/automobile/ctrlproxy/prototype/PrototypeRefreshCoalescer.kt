package dev.jasonpearson.automobile.ctrlproxy.prototype

import java.util.concurrent.atomic.AtomicBoolean

/** Coalesces queued refreshes without suppressing a request that arrives during the action. */
internal class PrototypeRefreshCoalescer(
  private val launch: (suspend () -> Unit) -> Unit,
  private val action: suspend () -> Unit,
) {
  private val pending = AtomicBoolean(false)

  fun request() {
    if (!pending.compareAndSet(false, true)) return
    launch {
      pending.set(false)
      action()
    }
  }
}
