package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSecureValueStore
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import dev.jasonpearson.automobile.prototype.PrototypeStorage

/** Maps every authored spec id to its app-owned library id; stale runtimes cannot undo a reset. */
class LibraryStorage(
  private val delegate: PrototypeStorage,
  private val secure: PrototypeSecureValueStore? = null,
) {
  private val generations = mutableMapOf<String, Long>()

  /** Both stores for one viewer capture their generation while reset is excluded. */
  @Synchronized
  fun namespaces(libraryId: String): Namespaces =
    Namespaces(namespace(libraryId), secureNamespace(libraryId))

  class Namespaces(val plain: PrototypeStorage, val secure: PrototypeSecureValueStore?)

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
  fun secureNamespace(libraryId: String): PrototypeSecureValueStore? {
    val store = secure ?: return null
    val generation = generations.getOrPut(libraryId) { 0 }
    return object : PrototypeSecureValueStore {
      override fun load(id: String): PrototypeStoredValues? =
        synchronized(this@LibraryStorage) {
          if (generations[libraryId] == generation) store.load(libraryId) else null
        }

      override fun save(id: String, stored: PrototypeStoredValues) =
        synchronized(this@LibraryStorage) {
          if (generations[libraryId] == generation) store.save(libraryId, stored)
        }

      override fun delete(id: String): Int =
        synchronized(this@LibraryStorage) {
          if (generations[libraryId] == generation) store.delete(libraryId) else 0
        }
    }
  }

  @Synchronized
  fun reset(libraryId: String) {
    delegate.delete(libraryId)
    secure?.delete(libraryId)
    generations[libraryId] = generations.getOrDefault(libraryId, 0) + 1
  }
}
