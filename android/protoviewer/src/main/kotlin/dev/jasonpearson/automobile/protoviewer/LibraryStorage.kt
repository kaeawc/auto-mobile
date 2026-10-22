package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import dev.jasonpearson.automobile.prototype.PrototypeStorage

/** Maps every authored spec id to its app-owned library id; stale runtimes cannot undo a reset. */
class LibraryStorage(private val delegate: PrototypeStorage) {
  private val generations = mutableMapOf<String, Long>()

  @Synchronized
  fun namespace(libraryId: String): PrototypeStorage {
    val generation = generations.getOrPut(libraryId) { 0 }
    return object : PrototypeStorage {
      override fun load(id: String): PrototypeStoredValues? =
        synchronized(this@LibraryStorage) {
          if (generations[libraryId] == generation) delegate.load(libraryId) else null
        }

      override fun save(id: String, values: PrototypeStoredValues) =
        synchronized(this@LibraryStorage) {
          if (generations[libraryId] == generation) delegate.save(libraryId, values)
        }

      override fun delete(id: String) =
        synchronized(this@LibraryStorage) {
          if (generations[libraryId] == generation) delegate.delete(libraryId)
        }
    }
  }

  @Synchronized
  fun reset(libraryId: String) {
    delegate.delete(libraryId)
    generations[libraryId] = generations.getOrDefault(libraryId, 0) + 1
  }
}
