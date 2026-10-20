package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import java.io.IOException

/** An in-memory [PrototypeStorageStore] that records every write and can refuse them. */
internal class FakePrototypeStorageStore : PrototypeStorageStore {
  val documents = mutableMapOf<String, PrototypeStorageLoad>()
  val saves = mutableListOf<Pair<String, PrototypeStoredValues>>()
  val deletes = mutableListOf<String>()
  var refuseWrites = false

  fun seed(id: String, stored: PrototypeStoredValues) {
    documents[id] = PrototypeStorageLoad.Loaded(stored)
  }

  fun stored(id: String): PrototypeStoredValues? =
    (documents[id] as? PrototypeStorageLoad.Loaded)?.stored

  override fun load(id: String): PrototypeStorageLoad =
    documents[id] ?: PrototypeStorageLoad.Missing

  override fun save(id: String, stored: PrototypeStoredValues) {
    if (refuseWrites) throw IOException("disk full")
    saves += id to stored
    documents[id] = PrototypeStorageLoad.Loaded(stored)
  }

  override fun delete(id: String): Boolean {
    if (refuseWrites) throw IOException("disk full")
    deletes += id
    return documents.remove(id) != null
  }
}
