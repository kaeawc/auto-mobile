package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.view.Display
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeWindowOnScreen
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeWindowOnScreen

/**
 * Answers whether this service's prototype window is on a display, from the accessibility windows
 * of type [W]. Before Android 11 only the default display's list exists, so any other display is
 * unknown; a failed read is unknown too. Null never counts as absence.
 */
internal class PrototypeWindowProbe<W>(
  private val sdkInt: Int,
  private val source: Source<W>,
  private val ownPackage: String,
  private val onFailure: (Exception) -> Unit,
) : PrototypeWindowOnScreen {
  /** The device's accessibility windows. */
  interface Source<W> {
    /** The service's window list, the default display's only; null while the framework has none. */
    fun legacyWindows(): List<W>?

    /** [displayId]'s windows, from Android 11. */
    fun displayWindows(displayId: Int): List<W>

    fun hasTitle(window: W): Boolean

    /** The package of [window]'s root node; null when the root cannot be read. */
    fun rootPackage(window: W): String?
  }

  @Suppress("TooGenericExceptionCaught") // Any window read failure means "unknown".
  override fun isOnScreen(displayId: Int): Boolean? =
    try {
      val selected =
        if (sdkInt < Build.VERSION_CODES.R) {
          source.legacyWindows()?.takeIf { displayId == Display.DEFAULT_DISPLAY }
        } else {
          source.displayWindows(displayId)
        }
      prototypeWindowOnScreen(selected, source::hasTitle, source::rootPackage, ownPackage)
    } catch (e: Exception) {
      onFailure(e)
      null
    }
}
