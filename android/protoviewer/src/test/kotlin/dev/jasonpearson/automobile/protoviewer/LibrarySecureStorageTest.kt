package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeSecureValueStore
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class LibrarySecureStorageTest {
  @Test
  fun `library namespace isolates authored ids and reset prevents stale secure writes`() {
    val secure = FakeSecureStore()
    val storage = LibraryStorage(FakePrototypeStorage(), secure)
    val first = storage.secureNamespace("first-library-entry")!!
    val second = storage.secureNamespace("second-library-entry")!!
    val value = PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("private-token")))
    first.save("same-authored-id", value)
    assertNull(second.load("same-authored-id"))
    assertEquals(value, storage.secureNamespace("first-library-entry")!!.load("same-authored-id"))
    storage.reset("first-library-entry")
    first.save("same-authored-id", value)
    assertNull(storage.secureNamespace("first-library-entry")!!.load("same-authored-id"))
    assertTrue(secure.values.isEmpty())
  }
}

private class FakeSecureStore : PrototypeSecureValueStore {
  val values = mutableMapOf<String, PrototypeStoredValues>()

  override fun load(id: String) = values[id]

  override fun save(id: String, stored: PrototypeStoredValues) {
    values[id] = stored
  }

  override fun delete(id: String): Int = values.remove(id)?.values?.size ?: 0
}
