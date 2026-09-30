package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Point
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.HandlerThread
import android.view.Display
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Delivers changes that can invalidate the rotation proven for an in-flight capture. */
internal interface RotationChangeSignal {
  /** Returns false when the platform cannot provide the required change notifications. */
  fun register(listener: (Int) -> Unit): Boolean

  /**
   * Drains notifications observed before this barrier, returning false if that cannot be proven.
   */
  fun synchronize(): Boolean

  fun unregister()
}

/** Android display callbacks. Each display advances its own capture provenance. */
internal data class DisplayTransition(
  val change: String,
  val displayId: Int,
  val panelUniqueId: String?,
  val width: Int?,
  val height: Int?,
  val state: Int?,
  val deviceState: Int? = null,
  val rotation: Int? = null,
)

internal class DisplayRotationChangeSignal(
  private val displayManager: DisplayManager?,
  private val onTransition: (DisplayTransition) -> Unit = {},
  private val snapshotOverride: ((Int, String) -> DisplayTransition?)? = null,
  private val scheduleTransition: ((Runnable, Long) -> Unit)? = null,
) : RotationChangeSignal {
  private var displayListener: DisplayManager.DisplayListener? = null
  private var callbackHandler: Handler? = null
  private var callbackThread: HandlerThread? = null
  private var rotationListener: ((Int) -> Unit)? = null
  private val lastDisplays = java.util.concurrent.ConcurrentHashMap<Int, DisplayTransition>()
  private val pendingTransitions = mutableMapOf<Int, DisplayTransition>()
  private val pendingRunnables = mutableMapOf<Int, Runnable>()

  private fun snapshot(displayId: Int, change: String): DisplayTransition? {
    snapshotOverride?.let {
      return it(displayId, change)
    }
    val display = displayManager?.getDisplay(displayId) ?: return null
    val size = Point()
    @Suppress("DEPRECATION") display.getRealSize(size)
    return DisplayTransition(
      change,
      displayId,
      panelUniqueIdOf(display),
      size.x,
      size.y,
      display.state,
      rotation = display.rotation,
    )
  }

  internal fun emitTransition(change: String, displayId: Int, deviceState: Int? = null) {
    val current = snapshot(displayId, change)
    if (change == "changed" && current == null) return
    val transition = current ?: lastDisplays[displayId]?.copy(change = change)
    val previous = lastDisplays[displayId]
    if (
      change == "changed" &&
        current != null &&
        previous != null &&
        current.width == previous.width &&
        current.height == previous.height &&
        current.state == previous.state &&
        current.panelUniqueId == previous.panelUniqueId &&
        current.rotation == previous.rotation
    )
      return
    if (change == "removed") {
      lastDisplays.remove(displayId)
      synchronized(pendingTransitions) { pendingTransitions.remove(displayId) }
    } else if (current != null) lastDisplays[displayId] = current
    if (transition != null) {
      rotationListener?.invoke(displayId)
      val frame = transition.copy(deviceState = deviceState)
      if (change == "changed" || change == "added") queueTransition(frame) else onTransition(frame)
    }
  }

  private fun queueTransition(transition: DisplayTransition) {
    val scheduler =
      scheduleTransition
        ?: callbackHandler?.let { handler ->
          { action: Runnable, delay: Long ->
            handler.postDelayed(action, delay)
            Unit
          }
        }
    if (scheduler == null) {
      onTransition(transition)
      return
    }
    synchronized(pendingTransitions) {
      pendingTransitions[transition.displayId] = transition
      if (pendingRunnables.containsKey(transition.displayId)) return
      val action = Runnable {
        val latest =
          synchronized(pendingTransitions) {
            pendingRunnables.remove(transition.displayId)
            pendingTransitions.remove(transition.displayId)
          }
        if (latest != null) onTransition(latest)
      }
      pendingRunnables[transition.displayId] = action
      scheduler(action, TRANSITION_DEBOUNCE_MS)
    }
  }

  internal fun emitDeviceState(deviceState: Int) {
    displayManager?.displays?.forEach {
      emitTransition("device_state", it.displayId, deviceState)
    }
  }

  internal fun handleDisplayCallback(change: String, displayId: Int) {
    emitTransition(change, displayId)
  }

  override fun register(listener: (Int) -> Unit): Boolean {
    check(displayListener == null) { "Display change listener is already registered" }
    val manager = displayManager ?: return false
    rotationListener = listener
    manager.displays.forEach { display ->
      snapshot(display.displayId, "changed")?.let { lastDisplays[display.displayId] = it }
    }
    val thread = HandlerThread("CtrlProxyRotationChanges").apply { start() }
    val handler = Handler(thread.looper)
    val registeredListener =
      object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {
          handleDisplayCallback("added", displayId)
        }

        override fun onDisplayChanged(displayId: Int) {
          handleDisplayCallback("changed", displayId)
        }

        override fun onDisplayRemoved(displayId: Int) {
          handleDisplayCallback("removed", displayId)
        }
      }
    try {
      manager.registerDisplayListener(registeredListener, handler)
    } catch (e: Exception) {
      rotationListener = null
      thread.quitSafely()
      throw e
    }
    displayListener = registeredListener
    callbackHandler = handler
    callbackThread = thread
    return true
  }

  override fun synchronize(): Boolean {
    val handler = callbackHandler ?: return false
    val barrier = CountDownLatch(1)
    if (!handler.post { barrier.countDown() }) return false
    return barrier.await(CALLBACK_DRAIN_TIMEOUT_MS, TimeUnit.MILLISECONDS)
  }

  override fun unregister() {
    val listener = displayListener ?: return
    displayManager?.unregisterDisplayListener(listener)
    displayListener = null
    rotationListener = null
    callbackHandler = null
    callbackThread?.quitSafely()
    callbackThread = null
    synchronized(pendingTransitions) {
      pendingTransitions.clear()
      pendingRunnables.clear()
    }
  }

  private companion object {
    const val CALLBACK_DRAIN_TIMEOUT_MS = 1_000L
    const val TRANSITION_DEBOUNCE_MS = 100L
  }
}

/**
 * Associates a rotation sample with a display-change generation.
 *
 * Endpoint rotation equality catches a transition when its display callback has not yet run, but it
 * misses A -> B -> A. A display callback increments that display's generation, so a matching end
 * rotation is only trusted if neither guard observed a transition.
 */
internal class RotationProvenanceTracker(private val changeSignal: RotationChangeSignal) :
  AutoCloseable {
  private val generations = java.util.concurrent.ConcurrentHashMap<Int, AtomicLong>()
  @Volatile private var isRegistered = false

  init {
    isRegistered = changeSignal.register { displayId ->
      generations.computeIfAbsent(displayId) { AtomicLong(0) }.incrementAndGet()
    }
  }

  fun beginCapture(displayId: Int = Display.DEFAULT_DISPLAY): Long =
    generations.computeIfAbsent(displayId) { AtomicLong(0) }.get()

  fun rotationIfUnchanged(
    captureGeneration: Long,
    rotationAtCaptureStart: Int?,
    rotationAtCaptureEnd: Int?,
    displayId: Int = Display.DEFAULT_DISPLAY,
  ): Int? {
    if (!isRegistered || !changeSignal.synchronize()) return null
    return if (
      captureGeneration == generations.computeIfAbsent(displayId) { AtomicLong(0) }.get() &&
        rotationAtCaptureStart == rotationAtCaptureEnd
    ) {
      rotationAtCaptureEnd
    } else {
      null
    }
  }

  override fun close() {
    changeSignal.unregister()
    isRegistered = false
  }
}
