package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** The file-backed storage: one atomic document per id under `prototype-storage/`. */
class PrototypeStorageDirectoryStoreTest {
  @get:Rule val folder = TemporaryFolder()

  private val values =
    PrototypeStoredValues(
      3,
      linkedMapOf(
        "state:dark" to JsonPrimitive(true),
        "data:/cart" to Json.parseToJsonElement("""{"items":["é"]}"""),
      ),
    )

  private fun store() = PrototypeStorageDirectoryStore(File(folder.root, "prototype-storage"))

  private fun documents() =
    File(folder.root, "prototype-storage").listFiles().orEmpty().map { it.name }

  @Test
  fun `a missing document is missing`() {
    assertEquals(PrototypeStorageLoad.Missing, store().load("prefs"))
    assertFalse(store().delete("prefs"))
  }

  @Test
  fun `save then load round-trips and leaves no temp file behind`() {
    val store = store()

    store.save("prefs", values)

    assertEquals(PrototypeStorageLoad.Loaded(values), store.load("prefs"))
    assertEquals(1, documents().size)
    assertTrue(
      documents().single(),
      documents().single().matches(Regex("prefs-[0-9a-f]{16}\\.json")),
    )
    // A second save replaces the first in place.
    store.save("prefs", PrototypeStoredValues(4, emptyMap()))
    assertEquals(
      PrototypeStorageLoad.Loaded(PrototypeStoredValues(4, emptyMap())),
      store.load("prefs"),
    )
    assertEquals(1, documents().size)
  }

  @Test
  fun `ids are file names that cannot escape the directory or collide`() {
    val store = store()
    store.save("../../etc/passwd", values)
    store.save("Prefs", PrototypeStoredValues(1, emptyMap()))
    store.save("prefs", PrototypeStoredValues(2, emptyMap()))

    assertEquals(3, documents().size)
    assertTrue(documents().all { it.matches(Regex("[a-z0-9-]+\\.json")) })
    assertEquals(PrototypeStorageLoad.Loaded(values), store.load("../../etc/passwd"))
    assertEquals(
      PrototypeStorageLoad.Loaded(PrototypeStoredValues(2, emptyMap())),
      store.load("prefs"),
    )
  }

  @Test
  fun `delete removes the document and says whether there was one`() {
    val store = store()
    store.save("prefs", values)

    assertTrue(store.delete("prefs"))
    assertFalse(store.delete("prefs"))
    assertEquals(PrototypeStorageLoad.Missing, store.load("prefs"))
  }

  @Test
  fun `unreadable documents are corrupt, not exceptions`() {
    val store = store()
    store.save("prefs", values)
    val file = File(folder.root, "prototype-storage").listFiles()!!.single()

    for (text in
      listOf(
        "not json",
        "[]",
        """{"id":"prefs","version":0,"values":{}}""",
        """{"id":"prefs","version":1}""",
        """{"id":"other","version":1,"values":{}}""",
        """{"version":1,"values":{}}""",
      )) {
      file.writeText(text)
      val loaded = store.load("prefs")
      assertTrue("$text -> $loaded", loaded is PrototypeStorageLoad.Corrupt)
    }
  }

  @Test
  fun `stores are shared per directory`() {
    val root = File(folder.root, "shared")
    assertSame(
      PrototypeStorageStores.inDirectory(root),
      PrototypeStorageStores.inDirectory(File(root, "../shared")),
    )
  }
}
