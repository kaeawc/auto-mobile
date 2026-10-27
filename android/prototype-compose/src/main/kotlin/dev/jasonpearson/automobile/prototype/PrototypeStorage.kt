package dev.jasonpearson.automobile.prototype

import android.content.Context
import dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStorageLoad
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStorageStore
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeStorageStores
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeStorageRoot
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues

/**
 * Persistence for a spec's declared storage keys, keyed by prototype id. Implementations must be
 * thread safe; calls run on the renderer's I/O dispatcher. Throw java.io.IOException for I/O
 * failure.
 */
interface PrototypeStorage {
  /** Return previously saved values, or null for an unknown or unusable document. */
  fun load(id: String): PrototypeStoredValues?

  /** Atomically replace the values belonging to [id]. */
  fun save(id: String, values: PrototypeStoredValues)

  /** Remove the values belonging to [id]. */
  fun delete(id: String)

  /** Storage factories; keep the returned instance stable across recompositions. */
  companion object {
    /** No persistence. Safe as a default without an Android context. */
    val None: PrototypeStorage =
      object : PrototypeStorage {
        override fun load(id: String): PrototypeStoredValues? = null

        override fun save(id: String, values: PrototypeStoredValues) = Unit

        override fun delete(id: String) = Unit
      }

    /** App-private, file-backed storage shared with other renderers in this app. */
    fun fileBacked(context: Context): PrototypeStorage {
      val store =
        PrototypeStorageStores.inDirectory(
          prototypeStorageRoot(context.applicationContext.filesDir),
        )
      return object : PrototypeStorage {
        override fun load(id: String): PrototypeStoredValues? =
          (store.load(id) as? PrototypeStorageLoad.Loaded)?.stored

        override fun save(id: String, values: PrototypeStoredValues) = store.save(id, values)

        override fun delete(id: String) {
          store.delete(id)
        }
      }
    }
  }
}

/** Retains typed corrupt/missing results for AutoMobile hosts sharing an existing store. */
@InternalAutoMobilePrototypeApi
fun prototypeHostStorage(store: PrototypeStorageStore): PrototypeStorage =
  HostPrototypeStorage(store)

private class HostPrototypeStorage(val store: PrototypeStorageStore) : PrototypeStorage {
  override fun load(id: String): PrototypeStoredValues? =
    (store.load(id) as? PrototypeStorageLoad.Loaded)?.stored

  override fun save(id: String, values: PrototypeStoredValues) = store.save(id, values)

  override fun delete(id: String) {
    store.delete(id)
  }
}

internal fun PrototypeStorage.adapt(): PrototypeStorageStore =
  if (this is HostPrototypeStorage) store
  else
    object : PrototypeStorageStore {
      override fun load(id: String): PrototypeStorageLoad =
        this@adapt.load(id)?.let { PrototypeStorageLoad.Loaded(it) } ?: PrototypeStorageLoad.Missing

      override fun save(id: String, stored: PrototypeStoredValues) = this@adapt.save(id, stored)

      override fun delete(id: String): Boolean {
        val existed = this@adapt.load(id) != null
        this@adapt.delete(id)
        return existed
      }
    }
