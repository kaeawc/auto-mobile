package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeDegradedEffect
import kotlinx.coroutines.CancellationException

sealed interface ViewerScreenState {
  data object Loading : ViewerScreenState

  data class Ready(val prototype: LibraryPrototype) : ViewerScreenState

  data class Error(val reason: LibraryError) : ViewerScreenState
}

internal fun loadViewer(id: String?, repository: LibraryRepository): ViewerScreenState {
  if (id.isNullOrBlank()) return ViewerScreenState.Error(LibraryError.NotFound)
  return try {
    when (val result = repository.get(id)) {
      is LibraryResult.Failure -> ViewerScreenState.Error(result.error)
      is LibraryResult.Success ->
        when (val marked = repository.markOpened(id)) {
          is LibraryResult.Failure -> ViewerScreenState.Error(marked.error)
          is LibraryResult.Success -> ViewerScreenState.Ready(result.value)
        }
    }
  } catch (error: CancellationException) {
    throw error
  } catch (_: Exception) {
    ViewerScreenState.Error(LibraryError.Storage)
  }
}

/** A compact summary; paths remain available to the host's inspect result. */
internal fun viewerEffectsNote(
  effects: List<PrototypeDegradedEffect>,
  format: (Int, Int) -> String,
): String? {
  if (effects.isEmpty()) return null
  return format(effects.count { it.reason == "api" }, effects.count { it.reason == "budget" })
}
