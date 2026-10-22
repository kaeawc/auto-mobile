package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.CoroutinePrototypeScheduler
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeScheduledTask
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeScheduler
import kotlinx.coroutines.CoroutineScope

/** Includes loading storage/fonts and the first successful content composition. */
const val RENDER_READY_BUDGET_MILLIS = 10_000L

fun interface RenderWatchdog {
  fun start(scope: CoroutineScope, onTimeout: () -> Unit): PrototypeScheduledTask
}

/** Reuse the renderer's cancellable timer contract; no second clock or background executor. */
class DeadlineRenderWatchdog(
  private val timer: (CoroutineScope) -> PrototypeScheduler = ::CoroutinePrototypeScheduler,
) : RenderWatchdog {
  override fun start(scope: CoroutineScope, onTimeout: () -> Unit): PrototypeScheduledTask {
    // Both expiry and cancellation run on the activity's main thread. Also guard a queued expiry
    // whose timer has already fired when readiness/disposal cancels its task.
    var pending = true
    val task =
      timer(scope).schedule(RENDER_READY_BUDGET_MILLIS) {
        if (pending) {
          pending = false
          onTimeout()
        }
      }
    return PrototypeScheduledTask {
      pending = false
      task.cancel()
    }
  }
}
