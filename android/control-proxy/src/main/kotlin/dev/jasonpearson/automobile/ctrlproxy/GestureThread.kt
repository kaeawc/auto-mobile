package dev.jasonpearson.automobile.ctrlproxy

import android.os.Handler
import android.os.HandlerThread

/** The single queue used for gesture mutations and AccessibilityService result callbacks. */
internal interface GestureThread {
  val handler: Handler

  fun post(work: () -> Unit): Boolean

  fun quitSafely()
}

internal class HandlerGestureThread : GestureThread {
  private val thread = HandlerThread("automobile-gesture-dispatch").apply { start() }
  override val handler = Handler(thread.looper)

  override fun post(work: () -> Unit): Boolean = handler.post(work)

  override fun quitSafely() {
    thread.quitSafely()
  }
}
