package dev.jasonpearson.automobile.sdk.keystore

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class KeystoreStateHandlerMetadataTest : KeystoreStateHandlerTestBase() {
  @Test
  fun `default disabled hides scopes and never touches backend or lock probe`() {
    KeystoreTestState.declareScope("fixture", setOf("aes"))
    val json = handler.handle("metadata", "fixture")
    assertEquals("disabled", json.getString("outcome"))
    assertEquals(0, json.getJSONArray("scopes").length())
    assertEquals(0, probe.calls)
    assertEquals("unknown", json.getString("deviceLocked"))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `discovery reports metadata and unsupported mutation without opening store`() {
    enable()
    val json = handler.handle("discover")
    assertEquals("ok", json.getString("outcome"))
    assertEquals("storage.keystore", json.getString("capability"))
    assertTrue(json.getBoolean("bridgeAvailable"))
    assertEquals("supported", json.getString("metadata"))
    assertEquals("declared_unsupported", json.getString("mutation"))
    assertEquals("fixture", json.getJSONArray("scopes").getString(0))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `contract metadata contains only alias presence and category`() {
    enable()
    backend.entries.putAll(
      mapOf(
        "aes" to EntryCategory.KEY,
        "private" to EntryCategory.PRIVATE_KEY,
        "cert" to EntryCategory.CERTIFICATE,
        "unknown" to EntryCategory.UNKNOWN,
      ),
    )
    val json = handler.handle("metadata", "fixture")
    val entries = json.getJSONArray("entries")
    assertEquals(5, entries.length())
    val byName =
      (0 until entries.length()).associate {
        entries.getJSONObject(it).let { entry -> entry.getString("alias") to entry }
      }
    backend.entries.forEach { (alias, category) ->
      assertEquals(category.name, byName.getValue(alias).getString("category"))
      assertTrue(byName.getValue(alias).getBoolean("present"))
    }
    assertFalse(byName.getValue("missing").getBoolean("present"))
    assertEquals("UNKNOWN", byName.getValue("missing").getString("category"))
    byName.values.forEach {
      assertEquals(setOf("alias", "present", "category"), it.keys().asSequence().toSet())
    }
    assertEquals(
      listOf(
        "containsAlias:aes",
        "entryCategory:aes",
        "containsAlias:cert",
        "entryCategory:cert",
        "containsAlias:missing",
        "containsAlias:private",
        "entryCategory:private",
        "containsAlias:unknown",
        "entryCategory:unknown",
      ),
      backend.calls,
    )
    assertEquals(
      setOf(
        "schemaVersion",
        "capability",
        "outcome",
        "bridgeAvailable",
        "metadata",
        "mutation",
        "deviceLocked",
        "scopes",
        "entries",
      ),
      json.keys().asSequence().toSet(),
    )
  }

  @Test
  fun `undeclared existing and missing aliases are indistinguishable without reads`() {
    enable()
    backend.entries["hidden"] = EntryCategory.SECRET_KEY
    assertEquals(
      handler.handle("metadata", "fixture", "hidden").toString(),
      handler.handle("metadata", "fixture", "absent").toString(),
    )
    assertEquals(
      "SCOPE_NOT_DECLARED",
      handler.handle("metadata", "fixture", "hidden").getString("reason"),
    )
    assertEquals(
      "SCOPE_NOT_DECLARED",
      handler.handle("metadata", "unknown", "aes").getString("reason"),
    )
    assertEquals("SCOPE_NOT_DECLARED", handler.handle("metadata", null, "aes").getString("reason"))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `all unknown and mutation calls are unsupported without backend calls`() {
    listOf("delete", "reset", "set", "unknown").forEach {
      assertEquals("disabled", handler.handle(it).getString("outcome"))
    }
    enable()
    listOf("delete", "reset", "set", "unknown").forEach {
      assertEquals("unsupported", handler.handle(it).getString("outcome"))
    }
    assertTrue(backend.calls.isEmpty())
  }
}
