package dev.jasonpearson.automobile.ctrlproxy

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
  fun register(listener: () -> Unit): Boolean

  /**
   * Drains notifications observed before this barrier, returning false if that cannot be proven.
   */
  fun synchronize(): Boolean

  fun unregister()
}

/**
 * Android's default-display callback. Any display change advances provenance because a capture
 * cannot safely distinguish which display state produced its pixels or hierarchy.
 */
internal class DisplayRotationChangeSignal(private val displayManager: DisplayManager?) :
  RotationChangeSignal {
  private var displayListener: DisplayManager.DisplayListener? = null
  private var callbackHandler: Handler? = null
  private var callbackThread: HandlerThread? = null

  override fun register(listener: () -> Unit): Boolean {
    check(displayListener == null) { "Display change listener is already registered" }
    val manager = displayManager ?: return false
    val thread = HandlerThread("CtrlProxyRotationChanges").apply { start() }
    val handler = Handler(thread.looper)
    val registeredListener =
      object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit

        override fun onDisplayChanged(displayId: Int) {
          if (displayId == Display.DEFAULT_DISPLAY) {
            listener()
          }
        }

        override fun onDisplayRemoved(displayId: Int) = Unit
      }
    try {
      manager.registerDisplayListener(registeredListener, handler)
    } catch (e: Exception) {
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
    callbackHandler = null
    callbackThread?.quitSafely()
    callbackThread = null
  }

  private companion object {
    const val CALLBACK_DRAIN_TIMEOUT_MS = 1_000L
  }
}

/**
 * Associates a rotation sample with a display-change generation.
 *
 * Endpoint rotation equality catches a transition when its display callback has not yet run, but it
 * misses A -> B -> A. The default-display callback increments [generation] for every change, so a
 * matching end rotation is only trusted if neither guard observed a transition.
 */
internal class RotationProvenanceTracker(private val changeSignal: RotationChangeSignal) :
  AutoCloseable {
  private val generation = AtomicLong(0)
  @Volatile private var isRegistered = false

  init {
    isRegistered = changeSignal.register { generation.incrementAndGet() }
  }

  fun beginCapture(): Long = generation.get()

  fun rotationIfUnchanged(
    captureGeneration: Long,
    rotationAtCaptureStart: Int?,
    rotationAtCaptureEnd: Int?,
  ): Int? {
    if (!isRegistered || !changeSignal.synchronize()) return null
    return if (
      captureGeneration == generation.get() && rotationAtCaptureStart == rotationAtCaptureEnd
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
