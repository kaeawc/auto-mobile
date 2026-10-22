package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.util.Log
import kotlinx.coroutines.CancellationException

/** Shortcut removal is deferred to the shortcut publisher (#12265). */
sealed interface SavedPrototypeScreenState {
  data object Loading : SavedPrototypeScreenState

  data class Ready(val loaded: SavedPrototypeLoadResult.Loaded) : SavedPrototypeScreenState

  data object MissingId : SavedPrototypeScreenState

  data object NotSaved : SavedPrototypeScreenState

  data object Corrupt : SavedPrototypeScreenState

  data class Unsupported(val version: Int) : SavedPrototypeScreenState

  data object Locked : SavedPrototypeScreenState
}

/** Caller runs this off-main; locked storage is never touched. Raw failures are never UI text. */
suspend fun loadSavedPrototypeState(
  id: String?,
  store: SavedPrototypeStore,
  isUserUnlocked: () -> Boolean,
): SavedPrototypeScreenState {
  if (id.isNullOrBlank()) return SavedPrototypeScreenState.MissingId
  if (!isUserUnlocked()) return SavedPrototypeScreenState.Locked
  return try {
    when (val result = store.load(id)) {
      is SavedPrototypeLoadResult.Loaded -> SavedPrototypeScreenState.Ready(result)
      SavedPrototypeLoadResult.NotFound -> SavedPrototypeScreenState.NotSaved
      is SavedPrototypeLoadResult.Corrupt -> SavedPrototypeScreenState.Corrupt
      is SavedPrototypeLoadResult.UnsupportedFormat ->
        SavedPrototypeScreenState.Unsupported(result.version)
    }
  } catch (error: CancellationException) {
    throw error
  } catch (error: Exception) {
    Log.w("SavedPrototypeActivity", "Saved prototype load failed", error)
    SavedPrototypeScreenState.Corrupt
  }
}
