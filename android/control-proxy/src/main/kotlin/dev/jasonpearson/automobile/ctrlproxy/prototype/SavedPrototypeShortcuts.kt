package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.pm.ShortcutManager
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CancellationException

interface SavedPrototypeShortcuts {
  fun pinnedIds(): Set<String>

  fun disable(ids: List<String>, message: String)
}

fun shortcutIdFor(prototypeId: String): String = prototypeId

/**
 * Public launcher APIs only; shortcuts are best effort and never block saved content operations.
 */
class AndroidSavedPrototypeShortcuts(private val context: Context) : SavedPrototypeShortcuts {
  override fun pinnedIds(): Set<String> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return emptySet()
    return try {
      context.getSystemService(ShortcutManager::class.java)?.pinnedShortcuts?.map { it.id }?.toSet()
        ?: emptySet()
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w(TAG, "Cannot read pinned prototype shortcuts", error)
      emptySet()
    }
  }

  override fun disable(ids: List<String>, message: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return
    try {
      context.getSystemService(ShortcutManager::class.java)?.disableShortcuts(ids, message)
    } catch (error: CancellationException) {
      throw error
    } catch (error: Exception) {
      Log.w(TAG, "Cannot disable prototype shortcuts", error)
    }
  }

  private companion object {
    const val TAG = "SavedPrototypeShortcuts"
  }
}
