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

  override fun addView(view: View, params: ViewGroup.LayoutParams) {
    check(mainThread.isMainThread())
    history += "add"
    this.view = view
    if (failAdd) throw IllegalStateException("fake add failure")
    added += snapshot(params)
  }

  override fun updateViewLayout(view: View, params: ViewGroup.LayoutParams) {
    check(mainThread.isMainThread())
    if (failUpdate) throw IllegalStateException("fake update failure")
    val copy = snapshot(params)
    updated += copy
    history +=
      if (copy.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0) "untouchable"
      else "touchable"
  }

  override fun removeViewImmediate(view: View) {
    check(mainThread.isMainThread())
    if (failRemove) throw IllegalStateException("fake remove failure")
    removals++
    history += "remove"
  }

  override fun removeView(view: View) = error("Host must use removeViewImmediate")

  @Suppress("OVERRIDE_DEPRECATION")
  override fun getDefaultDisplay(): Display? = error("Host must use injected context density")

  private fun snapshot(params: ViewGroup.LayoutParams) =
    WindowManager.LayoutParams().apply { copyFrom(params as WindowManager.LayoutParams) }
}
