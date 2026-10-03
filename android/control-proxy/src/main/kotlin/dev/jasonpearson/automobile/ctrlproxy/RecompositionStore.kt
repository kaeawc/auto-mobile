package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.RecompositionEntry
import dev.jasonpearson.automobile.ctrlproxy.models.RecompositionSnapshot
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean

class RecompositionStore {
  private val enabled = AtomicBoolean(false)
  @Volatile private var state = SnapshotState(null, 0, emptyMap())

  private class SnapshotState(
    val applicationId: String?,
    val timestamp: Long,
    val entriesById: Map<String, RecompositionEntry>,
  )

  fun setEnabled(isEnabled: Boolean) {
    enabled.set(isEnabled)
    if (!isEnabled) {
      state = SnapshotState(null, 0, emptyMap())
    }
  }

  fun isEnabled(): Boolean = enabled.get()

  fun updateSnapshot(snapshot: RecompositionSnapshot) {
    if (!enabled.get()) {
      return
    }

    val entriesById = Collections.unmodifiableMap(snapshot.entries.associateBy { it.id })
    state = SnapshotState(snapshot.applicationId, snapshot.timestamp, entriesById)
  }

  fun isForPackage(packageName: String?): Boolean {
    val current = state
    return packageName != null && packageName == current.applicationId
  }

  fun findMatch(extras: Map<String, String>?): RecompositionEntry? {
    val current = state
    val id = extras?.get(RECOMPOSITION_ID_KEY) ?: return null
    return current.entriesById[id]
  }

  companion object {
    const val RECOMPOSITION_ID_KEY = "auto-mobile-recomposition-id"
  }
}
