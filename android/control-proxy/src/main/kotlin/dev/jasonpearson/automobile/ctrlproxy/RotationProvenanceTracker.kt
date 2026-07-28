package dev.jasonpearson.automobile.ctrlproxy

import android.hardware.display.DisplayManager
import android.view.Display
import java.util.concurrent.atomic.AtomicLong

/** Delivers changes that can invalidate the rotation proven for an in-flight capture. */
internal interface RotationChangeSignal {
  /** Returns false when the platform cannot provide the required change notifications. */
  fun register(listener: () -> Unit): Boolean

  fun unregister()
}

/**
 * Android's default-display callback. Any display change advances provenance because a capture
 * cannot safely distinguish which display state produced its pixels or hierarchy.
 */
internal class DisplayRotationChangeSignal(private val displayManager: DisplayManager?) :
  RotationChangeSignal {
  private var displayListener: DisplayManager.DisplayListener? = null

  override fun register(listener: () -> Unit): Boolean {
    check(displayListener == null) { "Display change listener is already registered" }
    val manager = displayManager ?: return false
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
    manager.registerDisplayListener(registeredListener, null)
    displayListener = registeredListener
    return true
  }

  override fun unregister() {
    val listener = displayListener ?: return
    displayManager?.unregisterDisplayListener(listener)
    displayListener = null
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
  ): Int? =
    if (
      isRegistered &&
        captureGeneration == generation.get() &&
        rotationAtCaptureStart == rotationAtCaptureEnd
    ) {
      rotationAtCaptureEnd
    } else {
      null
    }

  override fun close() {
    changeSignal.unregister()
    isRegistered = false
  }
}
