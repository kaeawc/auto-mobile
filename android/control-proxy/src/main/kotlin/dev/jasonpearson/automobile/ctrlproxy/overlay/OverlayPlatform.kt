package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Narrow main queue seam; post must enqueue on main and report whether it accepted the work. */
interface OverlayMainThread {
  fun isMainThread(): Boolean

  fun post(work: () -> Unit): Boolean
}

class AndroidOverlayMainThread : OverlayMainThread {
  private val handler = Handler(Looper.getMainLooper())

  override fun isMainThread(): Boolean = Looper.myLooper() == Looper.getMainLooper()

  override fun post(work: () -> Unit): Boolean = handler.post(work)
}

/** Gesture-worker and desktop delay seams cannot provide the host's main-queue/settle contract. */
fun interface OverlaySettleTimer {
  suspend fun awaitSettle(millis: Long)
}

object CoroutineOverlaySettleTimer : OverlaySettleTimer {
  override suspend fun awaitSettle(millis: Long) {
    delay(millis)
  }
}

/**
 * Runs inline on main, otherwise posts and awaits the actual result. Once enqueued, a mutation
 * completes even if its caller is cancelled; this prevents abandoned adds and half-applied flags.
 */
internal suspend fun <T> OverlayMainThread.onMain(work: () -> T): T {
  if (isMainThread()) return work()
  return suspendCoroutine { continuation ->
    val accepted = post {
      val result =
        try {
          work()
        } catch (error: Exception) {
          Log.e("InteractiveOverlayHost", "Posted overlay operation failed", error)
          continuation.resumeWithException(error)
          return@post
        }
      continuation.resume(result)
    }
    check(accepted) { "Main queue refused overlay operation" }
  }
}

/** The service supplies its own scope; the standalone host uses main for window-safe delivery. */
class CoroutineOverlayScheduler(
  private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()),
) : OverlayScheduler {
  override fun schedule(millis: Long, action: suspend () -> Unit): OverlayScheduledTask {
    val job = scope.launch {
      delay(millis)
      action()
    }
    return OverlayScheduledTask { job.cancel() }
  }
}
