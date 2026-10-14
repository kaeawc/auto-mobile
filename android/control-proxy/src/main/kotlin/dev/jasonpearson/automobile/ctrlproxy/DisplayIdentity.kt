package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import android.view.Display

private const val TAG = "DisplayIdentity"

private val panelUniqueIdResolver =
  PanelUniqueIdResolver<Display>(
    lookup = {
      val method = Display::class.java.getMethod("getUniqueId")
      val read: (Display) -> String? = { display -> method.invoke(display) as? String }
      read
    },
    onUnavailable = { error ->
      Log.d(TAG, "Display.getUniqueId() is unavailable; panelUniqueId will be omitted", error)
    },
  )

/**
 * Physical panel ID uses a hidden API, blocked on API 36, resolved once per process. When
 * unavailable, the host maps the logical displayId to a panel itself.
 */
internal fun panelUniqueIdOf(display: Display?): String? = panelUniqueIdResolver.resolve(display)

/** Looks up and caches the accessor for a display's physical panel id; a failed lookup is final. */
internal class PanelUniqueIdResolver<D : Any>(
  private val lookup: () -> ((D) -> String?)?,
  private val onUnavailable: (Throwable?) -> Unit = {},
) {
  private val lock = Any()
  private var resolved = false
  private var accessor: ((D) -> String?)? = null

  fun resolve(display: D?): String? {
    if (display == null) return null
    // Serialize invocation too, so no caller can invoke after another caller latches a failure.
    return synchronized(lock) {
      if (resolved && accessor == null) return@synchronized null
      val value =
        try {
          if (!resolved) {
            resolved = true
            accessor = lookup()
          }
          accessor?.invoke(display)
        } catch (e: Exception) {
          return@synchronized unavailable(e)
        } catch (e: LinkageError) {
          return@synchronized unavailable(e)
        }
      if (accessor == null) unavailable(null) else value
    }
  }

  private fun unavailable(error: Throwable?): String? {
    resolved = true
    accessor = null
    onUnavailable(error)
    return null
  }
}

/** Native panel dimensions, independent of logical display rotation and overrides. */
internal data class PanelFingerprint(val width: Int, val height: Int)

internal fun panelFingerprintFromSize(width: Int, height: Int): PanelFingerprint? =
  if (width > 0 && height > 0) PanelFingerprint(width, height) else null

internal fun panelFingerprintOf(display: Display?): PanelFingerprint? =
  readPanelFingerprint(
    readMode = {
      display?.mode?.let { panelFingerprintFromSize(it.physicalWidth, it.physicalHeight) }
    },
    onUnavailable = { error ->
      Log.d(TAG, "Display.getMode() is unavailable; panelFingerprint will be omitted", error)
    },
  )

internal fun readPanelFingerprint(
  readMode: () -> PanelFingerprint?,
  onUnavailable: (IllegalStateException) -> Unit,
): PanelFingerprint? =
  try {
    readMode()
  } catch (error: IllegalStateException) {
    // A mode change can invalidate this optional identity hint; capture can safely continue.
    onUnavailable(error)
    null
  }
