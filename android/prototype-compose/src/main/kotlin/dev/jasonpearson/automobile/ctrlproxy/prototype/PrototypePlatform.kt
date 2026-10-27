package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/** Narrow main queue seam; post must enqueue on main and report whether it accepted the work. */
@InternalAutoMobilePrototypeApi
interface PrototypeMainThread {
  fun isMainThread(): Boolean

  fun post(work: () -> Unit): Boolean
}

@InternalAutoMobilePrototypeApi
class AndroidPrototypeMainThread : PrototypeMainThread {
  private val handler = Handler(Looper.getMainLooper())

  override fun isMainThread(): Boolean = Looper.myLooper() == Looper.getMainLooper()

  override fun post(work: () -> Unit): Boolean = handler.post(work)
}

/** Gesture-worker and desktop delay seams cannot provide the host's main-queue/settle contract. */
@InternalAutoMobilePrototypeApi
fun interface PrototypeSettleTimer {
  suspend fun awaitSettle(millis: Long)
}

@InternalAutoMobilePrototypeApi
object CoroutinePrototypeSettleTimer : PrototypeSettleTimer {
  override suspend fun awaitSettle(millis: Long) {
    delay(millis)
  }
}

/**
 * Runs inline on main, otherwise posts and awaits the actual result. Once enqueued, a mutation
 * completes even if its caller is cancelled; this prevents abandoned adds and half-applied flags.
 */
@InternalAutoMobilePrototypeApi
suspend fun <T> PrototypeMainThread.onMain(work: () -> T): T {
  if (isMainThread()) return work()
  return suspendCoroutine { continuation ->
    val accepted = post {
      val result =
        try {
          work()
        } catch (error: Exception) {
          Log.e("PrototypeHost", "Posted prototype operation failed", error)
          continuation.resumeWithException(error)
          return@post
        }
      continuation.resume(result)
    }
    check(accepted) { "Main queue refused prototype operation" }
  }
}

/** The service supplies its own scope; the standalone host uses main for window-safe delivery. */
@InternalAutoMobilePrototypeApi
class CoroutinePrototypeScheduler(
  private val scope: CoroutineScope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob()),
) : PrototypeScheduler {
  override fun schedule(millis: Long, action: suspend () -> Unit): PrototypeScheduledTask {
    val job = scope.launch {
      delay(millis)
      action()
    }
    return PrototypeScheduledTask { job.cancel() }
  }
}

/** Waits for frames the main thread renders; the hide-for-capture seam (#9305). */
@InternalAutoMobilePrototypeApi
fun interface PrototypeFrameWaiter {
  suspend fun awaitFrames(count: Int)
}

/**
 * Each frame callback runs before that frame's traversal, so the first callback can precede the
 * relayout that hides a window; the second follows a frame in which the hide was applied.
 */
@InternalAutoMobilePrototypeApi
object ChoreographerPrototypeFrameWaiter : PrototypeFrameWaiter {
  override suspend fun awaitFrames(count: Int) {
    repeat(count) {
      withContext(Dispatchers.Main) {
        val choreographer = Choreographer.getInstance()
        suspendCancellableCoroutine { continuation ->
          val callback = Choreographer.FrameCallback { continuation.resume(Unit) }
          choreographer.postFrameCallback(callback)
          continuation.invokeOnCancellation { choreographer.removeFrameCallback(callback) }
        }
      }
    }
  }
}
