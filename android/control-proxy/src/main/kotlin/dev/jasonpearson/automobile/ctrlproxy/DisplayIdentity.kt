package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.util.Log
import android.view.Display
import java.lang.reflect.InvocationTargetException

private const val TAG = "DisplayIdentity"

private val panelUniqueIdResolver =
  PanelUniqueIdResolver<Display>(
    lookup = {
      val method = Display::class.java.getMethod("getUniqueId")
      val read: (Display) -> String? = { display -> method.invoke(display) as? String }
      read
    },
    onTransientFailure = { error ->
      Log.d(TAG, "Display.getUniqueId() failed transiently; panelUniqueId will be omitted", error)
    },
    onUnavailable = { error ->
      Log.d(TAG, "Display.getUniqueId() is unavailable; panelUniqueId will be omitted", error)
    },
  )

/**
 * Physical panel ID uses a hidden API, skipped on API 36+, resolved once per process. When
 * unavailable, the host maps the logical displayId to a panel itself.
 */
internal fun panelUniqueIdOf(display: Display?): String? = panelUniqueIdResolver.resolve(display)

/** Looks up and caches the accessor for a display's physical panel id; a failed lookup is final. */
internal class PanelUniqueIdResolver<D : Any>(
  private val lookup: () -> ((D) -> String?)?,
  private val onUnavailable: (Throwable?) -> Unit = {},
  private val onTransientFailure: (Throwable) -> Unit = {},
  private val sdkInt: Int = Build.VERSION.SDK_INT,
) {
  private companion object {
    private const val MAX_SDK_WITH_HIDDEN_UNIQUE_ID = 35
  }

  private val lock = Any()
  private var resolved = false
  private var transientFailureLogged = false
  private var accessor: ((D) -> String?)? = null

  fun resolve(display: D?): String? {
    if (display == null || sdkInt > MAX_SDK_WITH_HIDDEN_UNIQUE_ID) return null
    // Serialize invocation too, so no caller can invoke after another caller latches a failure.
    return synchronized(lock) {
      if (resolved && accessor == null) return@synchronized null
      if (!resolved) {
        resolved = true
        accessor =
          try {
            lookup()
          } catch (error: Exception) {
            return@synchronized unavailable(error)
          } catch (error: LinkageError) {
            return@synchronized unavailable(error)
          }
        if (accessor == null) return@synchronized unavailable(null)
      }
      try {
        accessor?.invoke(display)
      } catch (error: Exception) {
        if (error is IllegalArgumentException || isAccessFailure(error)) {
          unavailable(error)
        } else {
          if (!transientFailureLogged) {
            transientFailureLogged = true
            onTransientFailure(error)
          }
          null
        }
      } catch (error: LinkageError) {
        unavailable(error)
      }
    }
  }

  private fun isAccessFailure(error: Throwable): Boolean =
    when (error) {
      is IllegalAccessException,
      is SecurityException,
      is LinkageError -> true
      is InvocationTargetException -> error.cause?.let(::isAccessFailure) == true
      else -> false
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
