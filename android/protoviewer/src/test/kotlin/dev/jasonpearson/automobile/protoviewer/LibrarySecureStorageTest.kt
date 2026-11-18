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
    val fresh = storage.secureNamespace("first-library-entry")!!
    fresh.save("same-authored-id", value)
    assertNull(first.load("same-authored-id"))
    assertEquals(0, first.delete("same-authored-id"))
    assertEquals(value, fresh.load("same-authored-id"))
  }

  @Test
  fun `viewer namespaces share a generation and both become stale on reset`() {
    val plain = FakePrototypeStorage()
    val secure = FakeSecureStore()
    val storage = LibraryStorage(plain, secure)
    val old = storage.namespaces("library-entry")
    val value = PrototypeStoredValues(1, mapOf("state:token" to JsonPrimitive("dummy-token")))
    old.plain.save("authored-id", value)
    old.secure!!.save("authored-id", value)
    assertEquals(value, old.plain.load("authored-id"))
    assertEquals(value, old.secure.load("authored-id"))
    storage.reset("library-entry")
    old.plain.save("authored-id", value)
    old.secure.save("authored-id", value)
    assertTrue(plain.values.isEmpty())
    assertTrue(secure.values.isEmpty())
    val fresh = storage.namespaces("library-entry")
    fresh.plain.save("authored-id", value)
    fresh.secure!!.save("authored-id", value)
    old.plain.delete("authored-id")
    assertEquals(0, old.secure.delete("authored-id"))
    assertNull(old.plain.load("authored-id"))
    assertNull(old.secure.load("authored-id"))
    assertEquals(value, fresh.plain.load("authored-id"))
    assertEquals(value, fresh.secure.load("authored-id"))
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
