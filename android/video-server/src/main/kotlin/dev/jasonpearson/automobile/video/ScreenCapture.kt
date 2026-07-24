package dev.jasonpearson.automobile.video

import android.hardware.display.VirtualDisplay
import android.view.Surface
import dev.jasonpearson.automobile.video.wrappers.DisplayControl

/**
 * Manages VirtualDisplay creation for screen mirroring.
 *
 * Uses hidden DisplayManagerGlobal APIs via [DisplayControl] to create a VirtualDisplay that
 * mirrors the main display. This only works when running as shell user (UID 2000).
 */
class ScreenCapture(
  private val width: Int,
  private val height: Int,
  private val densityDpi: Int,
) {
  private var virtualDisplay: VirtualDisplay? = null
  private var surface: Surface? = null

  /**
   * Create a VirtualDisplay that mirrors the main display.
   *
   * @param surface The surface to render to (typically from MediaCodec)
   * @return The created VirtualDisplay
   */
  fun start(surface: Surface): VirtualDisplay {
    val display =
      DisplayControl.createVirtualDisplay(
        name = "automobile-mirror",
        width = width,
        height = height,
        densityDpi = densityDpi,
        surface = surface,
        displayIdToMirror = 0, // Mirror the main display
      )
    virtualDisplay = display
    this.surface = surface
    return display
  }

  /**
   * Force the mirror to re-submit a frame to the encoder surface. On a static screen no new buffers
   * are queued, so the encoder stalls after its initial burst and a keyframe request cannot produce
   * a fresh IDR (issue #4383).
   *
   * The nudge detaches then re-attaches the output surface: `DisplayManagerService`'s
   * `VirtualDisplayDevice.setSurfaceLocked` short-circuits on a reference-equality check (`mSurface
   * != surface`), so re-applying the SAME surface is a no-op. Clearing to null and then re-setting
   * passes that guard both times, forcing a traversal that re-composites the mirror onto the
   * surface and pushes a fresh frame the encoder can emit. Safe to call from the encode loop
   * thread; the codec's own IDR interval still bounds GOP.
   */
  fun forceFrame() {
    val display = virtualDisplay ?: return
    val surface = this.surface ?: return
    try {
      display.setSurface(null)
      display.setSurface(surface)
    } catch (e: Exception) {
      // Best-effort nudge: a released display surfaces its own failure via the encode loop.
      System.err.println("forceFrame failed: ${e.message}")
    }
  }

  /** Release the VirtualDisplay. */
  fun stop() {
    virtualDisplay?.release()
    virtualDisplay = null
    surface = null
  }
}
