package dev.jasonpearson.automobile.ctrlproxy

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
        if (isAccessFailure(error)) unavailable(error) else null
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
