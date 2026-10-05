package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.Display
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import kotlinx.coroutines.CompletableDeferred

internal class FakeOverlayMainThread : OverlayMainThread {
  var onMain = true
  val pending = ArrayDeque<() -> Unit>()
  var acceptPosts = true

  override fun isMainThread() = onMain

  override fun post(work: () -> Unit): Boolean {
    if (!acceptPosts) return false
    pending.addLast(work)
    return true
  }

  fun drain() {
    val previous = onMain
    onMain = true
    try {
      while (pending.isNotEmpty()) pending.removeFirst().invoke()
    } finally {
      onMain = previous
    }
  }
}

internal class FakeOverlaySettleTimer(private val history: MutableList<String>) :
  OverlaySettleTimer {
  val waits = mutableListOf<Long>()
  var gate: CompletableDeferred<Unit>? = null

  override suspend fun awaitSettle(millis: Long) {
    waits += millis
    history += "settle:$millis"
    gate?.await()
  }
}

/** Does not attach a real window or create a composition; records independent params snapshots. */
internal class RecordingOverlayWindowManager(
  private val mainThread: FakeOverlayMainThread,
  private val history: MutableList<String>,
) : WindowManager {
  var view: View? = null
  val added = mutableListOf<WindowManager.LayoutParams>()
  val updated = mutableListOf<WindowManager.LayoutParams>()
  var removals = 0
  var failAdd = false
  var failUpdate = false
  var failRemove = false
  var updateFailure: Exception = IllegalStateException("fake update failure")
  var removeFailure: Exception = IllegalStateException("fake remove failure")

  override fun addView(view: View, params: ViewGroup.LayoutParams) {
    check(mainThread.isMainThread())
    history += "add"
    this.view = view
    if (failAdd) throw IllegalStateException("fake add failure")
    added += snapshot(params)
  }

  override fun updateViewLayout(view: View, params: ViewGroup.LayoutParams) {
    check(mainThread.isMainThread())
    if (failUpdate) throw updateFailure
    val copy = snapshot(params)
    updated += copy
    history +=
      if (copy.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0) "untouchable"
      else "touchable"
  }

  override fun removeViewImmediate(view: View) {
    check(mainThread.isMainThread())
    if (failRemove) throw removeFailure
    removals++
    history += "remove"
  }

  override fun removeView(view: View) = error("Host must use removeViewImmediate")

  @Suppress("OVERRIDE_DEPRECATION")
  override fun getDefaultDisplay(): Display? = error("Host must use injected context density")

  private fun snapshot(params: ViewGroup.LayoutParams) =
    WindowManager.LayoutParams().apply { copyFrom(params as WindowManager.LayoutParams) }
}

internal class FakeInteractiveOverlayHost : InteractiveOverlayHost {
  val calls = mutableListOf<String>()
  val requests = mutableListOf<InteractiveOverlayRequest>()
  var accept = true
  var failure: Exception? = null
  override var isShowing = false
  override var currentPlacement: OverlayPlacement? = null
  override val isTouchThroughActive = false

  private fun display(operation: String, request: InteractiveOverlayRequest): Boolean {
    calls += operation
    failure?.let { throw it }
    if (accept) {
      requests += request
      isShowing = true
      currentPlacement = request.placement
    }
    return accept
  }

  override suspend fun show(request: InteractiveOverlayRequest) = display("show", request)

  override suspend fun replace(request: InteractiveOverlayRequest) = display("replace", request)

  override suspend fun relayout(): Boolean {
    calls += "relayout"
    return accept
  }

  override suspend fun dismiss(): Boolean {
    calls += "dismiss"
    failure?.let { throw it }
    if (accept) isShowing = false
    return accept
  }

  override suspend fun destroy(): Boolean {
    calls += "destroy"
    failure?.let { throw it }
    if (accept) isShowing = false
    return accept
  }

  override suspend fun setOpacity(percent: Int) {
    calls += "opacity:$percent"
  }

  override suspend fun <T> withTouchThrough(settleMillis: Long, block: suspend () -> T): T = block()
}

/** Virtual one-shot scheduler; cancelled callbacks can also be exercised to model queue races. */
internal class FakeOverlayTimer : OverlayScheduler {
  internal data class Task(
    val deadline: Long,
    val action: suspend () -> Unit,
    var cancelled: Boolean = false,
    var fired: Boolean = false,
  )

  var now = 0L
    private set

  val tasks = mutableListOf<Task>()

  override fun schedule(millis: Long, action: suspend () -> Unit): OverlayScheduledTask {
    val task = Task(now + millis, action)
    tasks += task
    return OverlayScheduledTask { task.cancelled = true }
  }

  suspend fun advance(millis: Long) {
    now += millis
    for (task in tasks.toList()) {
      if (!task.cancelled && !task.fired && task.deadline <= now) {
        task.fired = true
        task.action()
      }
    }
  }
}
