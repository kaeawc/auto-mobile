package dev.jasonpearson.automobile.desktop.core.storage

import dev.jasonpearson.automobile.desktop.core.daemon.StorageStreamUpdate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Covers how a live `storage_update` frame is folded into the displayed key-value files. */
class KeyValueLiveUpdatesTest {

  private fun file(name: String, vararg entries: Pair<String, Any?>) =
    KeyValueFile(
      name = name,
      path = "/data/data/com.example/shared_prefs/$name",
      platform = StoragePlatform.Android,
      entries = entries.map { (k, v) -> KeyValueEntry(k, v, KeyValueType.String) },
    )

  private fun update(
    fileName: String = "prefs.xml",
    key: String? = "theme",
    value: String? = "dark",
    valueType: KeyValueType = KeyValueType.String,
    packageName: String = "com.example",
  ) =
    StorageStreamUpdate(
      deviceId = "emulator-5554",
      timestamp = 1_000L,
      packageName = packageName,
      fileName = fileName,
      key = key,
      value = value,
      valueType = valueType,
      sequenceNumber = 1L,
    )

  @Test
  fun `an updated key replaces its value in place`() {
    val files = listOf(file("prefs.xml", "theme" to "light", "locale" to "en"))

    val result = files.applyStorageUpdate(update(key = "theme", value = "dark"))

    val entries = result.single().entries
    assertEquals(listOf("theme", "locale"), entries.map { it.key }, "order should be preserved")
    assertEquals("dark", entries.first { it.key == "theme" }.value)
  }

  @Test
  fun `a new key is appended`() {
    val files = listOf(file("prefs.xml", "theme" to "light"))

    val result = files.applyStorageUpdate(update(key = "fontScale", value = "1.5"))

    assertEquals(listOf("theme", "fontScale"), result.single().entries.map { it.key })
  }

  @Test
  fun `a null value deletes the key`() {
    val files = listOf(file("prefs.xml", "theme" to "light", "locale" to "en"))

    val result = files.applyStorageUpdate(update(key = "theme", value = null))

    assertEquals(listOf("locale"), result.single().entries.map { it.key })
  }

  @Test
  fun `a null key clears the whole file`() {
    val files = listOf(file("prefs.xml", "theme" to "light", "locale" to "en"))

    val result = files.applyStorageUpdate(update(key = null, value = null))

    assertTrue(result.single().entries.isEmpty())
  }

  @Test
  fun `other files are left untouched`() {
    val files = listOf(file("prefs.xml", "theme" to "light"), file("other.xml", "theme" to "keep"))

    val result = files.applyStorageUpdate(update(fileName = "prefs.xml", value = "dark"))

    assertEquals("keep", result.first { it.name == "other.xml" }.entries.single().value)
  }

  @Test
  fun `an update for an unloaded file is ignored`() {
    val files = listOf(file("prefs.xml", "theme" to "light"))

    val result = files.applyStorageUpdate(update(fileName = "never-fetched.xml"))

    assertSame(files, result, "unchanged input should be returned as-is")
  }

  @Test
  fun `a no-op delete returns the same instance`() {
    val files = listOf(file("prefs.xml", "theme" to "light"))

    val result = files.applyStorageUpdate(update(key = "absent", value = null))

    assertSame(files, result, "no entry changed, so recomposition should be skippable")
  }

  @Test
  fun `typed values are decoded to their kotlin types`() {
    val files = listOf(file("prefs.xml", "count" to 0))

    val asInt =
      files.applyStorageUpdate(update(key = "count", value = "42", valueType = KeyValueType.Int))
    assertEquals(42, asInt.single().entries.single().value)

    val asBool =
      files.applyStorageUpdate(
        update(key = "count", value = "true", valueType = KeyValueType.Boolean)
      )
    assertEquals(true, asBool.single().entries.single().value)

    val asSet =
      files.applyStorageUpdate(
        update(key = "count", value = """["a","b"]""", valueType = KeyValueType.StringSet)
      )
    assertEquals(setOf("a", "b"), asSet.single().entries.single().value)
  }

  @Test
  fun `a value that does not match its declared type falls back to the raw string`() {
    val files = listOf(file("prefs.xml", "count" to 0))

    val result =
      files.applyStorageUpdate(
        update(key = "count", value = "not-a-number", valueType = KeyValueType.Int)
      )

    assertEquals("not-a-number", result.single().entries.single().value)
  }

  @Test
  fun `a malformed string set falls back rather than throwing`() {
    val files = listOf(file("prefs.xml", "tags" to ""))

    val result =
      files.applyStorageUpdate(
        update(key = "tags", value = "{not json", valueType = KeyValueType.StringSet)
      )

    assertEquals("{not json", result.single().entries.single().value)
  }

  @Test
  fun `highlight keys are scoped by file name`() {
    val files = listOf(file("prefs.xml", "theme" to "light"))

    assertEquals(setOf("prefs.xml:theme"), update(key = "theme").highlightKeys(files))
  }

  @Test
  fun `clearing a file highlights every key it had`() {
    val files = listOf(file("prefs.xml", "theme" to "light", "locale" to "en"))

    assertEquals(
      setOf("prefs.xml:theme", "prefs.xml:locale"),
      update(key = null, value = null).highlightKeys(files),
    )
  }

  @Test
  fun `an unknown protocol type degrades to Unknown instead of dropping the update`() {
    val files = listOf(file("prefs.xml", "when" to ""))

    // DATE is emitted by iOS devices but has no desktop enum member.
    val result =
      files.applyStorageUpdate(
        update(
          key = "when",
          value = "2026-07-19",
          valueType = KeyValueType.fromProtocolName("DATE"),
        )
      )

    val entry = result.single().entries.single()
    assertEquals(KeyValueType.Unknown, entry.type)
    assertEquals("2026-07-19", entry.value)
  }

  @Test
  fun `protocol names map case-insensitively`() {
    assertEquals(KeyValueType.StringSet, KeyValueType.fromProtocolName("string_set"))
    assertEquals(KeyValueType.Int, KeyValueType.fromProtocolName("INT"))
    assertEquals(KeyValueType.Unknown, KeyValueType.fromProtocolName("nonsense"))
  }

  // -- Optimistic post-save edit (#4709): the same fold the live stream uses, but driven locally
  // right after a successful setKeyValue so the displayed value never shows stale.

  @Test
  fun `an optimistic edit replaces the saved value in place`() {
    val files = listOf(file("prefs.xml", "theme" to "light", "locale" to "en"))

    val result = files.applyKeyValueEdit("prefs.xml", "theme", "dark", KeyValueType.String)

    val entries = result.single().entries
    assertEquals(listOf("theme", "locale"), entries.map { it.key }, "order should be preserved")
    assertEquals("dark", entries.first { it.key == "theme" }.value)
  }

  @Test
  fun `an optimistic edit decodes to the saved value's type`() {
    val files = listOf(file("prefs.xml", "count" to 0))

    val result = files.applyKeyValueEdit("prefs.xml", "count", "42", KeyValueType.Int)

    assertEquals(42, result.single().entries.single().value)
  }

  @Test
  fun `an optimistic edit with a null value deletes the key`() {
    val files = listOf(file("prefs.xml", "theme" to "light", "locale" to "en"))

    val result = files.applyKeyValueEdit("prefs.xml", "theme", null, KeyValueType.String)

    assertEquals(listOf("locale"), result.single().entries.map { it.key })
  }

  @Test
  fun `an optimistic edit for an unloaded file is ignored`() {
    val files = listOf(file("prefs.xml", "theme" to "light"))

    val result = files.applyKeyValueEdit("never-fetched.xml", "theme", "dark", KeyValueType.String)

    assertSame(files, result, "an edit to a file the pane hasn't loaded changes nothing")
  }
}
