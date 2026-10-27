package dev.jasonpearson.automobile.ctrlproxy

import android.graphics.Point
import android.hardware.display.DisplayManager
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.WindowManager
import dev.jasonpearson.automobile.ctrlproxy.models.DisplayCutoutInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ObservationInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.ScreenDimensions
import dev.jasonpearson.automobile.ctrlproxy.models.SystemBarsInsetsInfo
import dev.jasonpearson.automobile.ctrlproxy.models.SystemInsetsInfo

// A secondary display's real size differs from the service window's metrics, including on API 30+.
@Suppress("DEPRECATION")
private fun readRealDisplaySize(display: Display, size: Point) = display.getRealSize(size)

// Window metrics are unavailable below API 30; preserve the default-display metrics lookup.
@Suppress("DEPRECATION")
private fun readLegacyDisplayMetrics(windowManager: WindowManager, metrics: DisplayMetrics) =
  windowManager.defaultDisplay.getRealMetrics(metrics)

// Preserve the WindowManager default-display lookup below API 30.
@Suppress("DEPRECATION")
private fun readLegacyDisplayRotation(windowManager: WindowManager): Int? =
  windowManager.defaultDisplay?.rotation

/**
 * Display facts: screen dimensions, rotation, insets, density and panel identity. Everything that
 * needs the live service context comes through [Host]. None of these reads touch the clock, so the
 * controller takes no time provider.
 */
internal class DisplayController(private val host: Host) {
  /** Service-side operations the controller cannot perform without the service context. */
  interface Host {
    fun displayManager(): DisplayManager?

    fun windowManager(): WindowManager?

    /** Supplies each requested display's inset categories and system chrome visibility. */
    fun displayInsetsProvider(): DisplayInsetsProvider

    /** The service resources' pixel size of a framework `dimen`, or 0 when it is not defined. */
    fun frameworkDimenPx(name: String): Int

    fun densityDpi(): Int
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  /** Get current screen dimensions for offscreen filtering. */
  fun getScreenDimensions(displayId: Int = Display.DEFAULT_DISPLAY): ScreenDimensions? {
    return try {
      if (displayId != Display.DEFAULT_DISPLAY && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val display = host.displayManager()?.getDisplay(displayId) ?: return null
        val size = Point()
        readRealDisplaySize(display, size)
        return ScreenDimensions(size.x, size.y)
      }
      val windowManager = host.windowManager()
      if (windowManager != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val bounds = windowManager.currentWindowMetrics.bounds
          ScreenDimensions(bounds.width(), bounds.height())
        } else {
          val displayMetrics = DisplayMetrics()
          readLegacyDisplayMetrics(windowManager, displayMetrics)
          ScreenDimensions(displayMetrics.widthPixels, displayMetrics.heightPixels)
        }
      } else {
        null
      }
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Failed to get screen dimensions", e)
      null
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "Failed to get screen dimensions", e)
      null
    } catch (e: SecurityException) {
      Log.w(TAG, "Failed to get screen dimensions", e)
      null
    }
  }

  fun panelUniqueId(displayId: Int): String? =
    host.displayManager()?.getDisplay(displayId).let(::panelUniqueIdOf)

  fun panelFingerprint(
    displayId: Int,
  ): dev.jasonpearson.automobile.ctrlproxy.models.PanelFingerprintInfo? =
    host.displayManager()?.getDisplay(displayId).let(::panelFingerprintOf)?.let {
      dev.jasonpearson.automobile.ctrlproxy.models.PanelFingerprintInfo(it.width, it.height)
    }

  /** Get current display rotation. Returns 0=portrait, 1=landscape90, 2=reverse, 3=landscape270. */
  fun getRotation(): Int {
    return getRotationOrNull() ?: 0
  }

  /**
   * Read the display rotation without inventing portrait when the display is unavailable.
   * Screenshot capture provenance uses this nullable form: an unknown rotation must make desktop
   * control fail closed, unlike the older diagnostic hierarchy/device-info fields that retain their
   * 0 fallback.
   */
  fun getRotationOrNull(displayId: Int = Display.DEFAULT_DISPLAY): Int? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Use DisplayManager for AccessibilityService context (can't use context.display)
        host.displayManager()?.getDisplay(displayId)?.rotation
      } else {
        host.windowManager()?.let(::readLegacyDisplayRotation)
      }
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Failed to get rotation", e)
      null
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "Failed to get rotation", e)
      null
    } catch (e: SecurityException) {
      Log.w(TAG, "Failed to get rotation", e)
      null
    }
  }

  /** Get typed current-window inset metadata for coordinate and layout inspection. */
  fun getObservationInsets(
    screenDimensions: ScreenDimensions?,
    displayId: Int = Display.DEFAULT_DISPLAY,
  ): ObservationInsetsInfo {
    if (displayId != Display.DEFAULT_DISPLAY) {
      return host.displayInsetsProvider().insetsFor(displayId, screenDimensions)
    }
    return try {
      val windowManager = host.windowManager()
      if (windowManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val metrics = windowManager.currentWindowMetrics
        val windowInsets = metrics.windowInsets
        observationInsetsFromWindowInsets(windowInsets, screenDimensions)
      } else {
        // API 24-29 cannot provide the typed WindowInsets categories from this service context.
        val statusBarHeight = host.frameworkDimenPx("status_bar_height")
        val navBarHeight = host.frameworkDimenPx("navigation_bar_height")
        val bars =
          SystemInsetsInfo(top = statusBarHeight, bottom = navBarHeight, left = 0, right = 0)
        ObservationInsetsInfo(
          source = "android-resource-fallback",
          systemBars = SystemBarsInsetsInfo(visible = bars, stable = bars),
          displayCutoutInfo = DisplayCutoutInfo.unknown(),
        )
      }
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Failed to get system insets", e)
      ObservationInsetsInfo(
        available = false,
        source = "unavailable",
        units = "unknown",
        displayCutoutInfo = DisplayCutoutInfo.unknown(),
      )
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "Failed to get system insets", e)
      ObservationInsetsInfo(
        available = false,
        source = "unavailable",
        units = "unknown",
        displayCutoutInfo = DisplayCutoutInfo.unknown(),
      )
    } catch (e: SecurityException) {
      Log.w(TAG, "Failed to get system insets", e)
      ObservationInsetsInfo(
        available = false,
        source = "unavailable",
        units = "unknown",
        displayCutoutInfo = DisplayCutoutInfo.unknown(),
      )
    } catch (e: android.content.res.Resources.NotFoundException) {
      Log.w(TAG, "Failed to get system insets", e)
      ObservationInsetsInfo(
        available = false,
        source = "unavailable",
        units = "unknown",
        displayCutoutInfo = DisplayCutoutInfo.unknown(),
      )
    }
  }

  /** Get display density in DPI. */
  fun getDensity(): Int {
    return try {
      host.densityDpi()
    } catch (e: android.content.res.Resources.NotFoundException) {
      Log.w(TAG, "Failed to get density", e)
      0
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "Failed to get density", e)
      0
    }
  }
}
