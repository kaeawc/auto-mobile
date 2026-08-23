package dev.jasonpearson.automobile.sdk.storage

import android.os.Bundle
import dev.jasonpearson.automobile.protocol.StorageProtocolSerializer
import dev.jasonpearson.automobile.protocol.StorageResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Regression coverage for DataStore-backed preferences served through the existing storage
 * inspection ContentProvider surface (issue #5192).
 */
@RunWith(RobolectricTestRunner::class)
class DataStoreInspectorProviderTest {
  private val provider = SharedPreferencesInspectorProvider()

  @Before
  fun setUp() {
    SharedPreferencesInspector.reset()
    DataStoreInspector.reset()
    SharedPreferencesInspector.setEnabled(true)
  }

  @After
  fun tearDown() {
    SharedPreferencesInspector.reset()
    DataStoreInspector.reset()
  }

  private fun bundleOf(vararg pairs: Pair<String, String>): Bundle =
    Bundle().apply { pairs.forEach { (k, v) -> putString(k, v) } }

  private fun successResult(bundle: Bundle): StorageResponse {
    assertTrue(
      "expected success, got ${bundle.getString("errorType")}: ${bundle.getString("error")}",
      bundle.getBoolean("success"),
    )
    val json = bundle.getString("result") ?: throw AssertionError("no result json")
    return StorageProtocolSerializer.responseFromJson(json)
      ?: throw AssertionError("could not parse result: $json")
  }

  @Test
  fun `listDataStores returns registered stores without exposing a path`() {
    DataStoreInspector.registerAdapter(
      "prefs",
      FakeDataStoreAdapter().apply {
        setStore("settings", mapOf("a" to 1, "b" to 2))
        setStore("flags", mapOf("x" to true))
      },
    )

    val response =
      successResult(provider.call("listDataStores", null, bundleOf("adapterName" to "prefs")))

    val fileList = response as StorageResponse.FileList
    val byName = fileList.files.associateBy { it.name }
    assertEquals(setOf("settings", "flags"), byName.keys)
    assertEquals(2, byName.getValue("settings").entryCount)
    assertEquals("", byName.getValue("settings").path)
  }

  @Test
  fun `getDataStore returns structured entries with types`() {
    DataStoreInspector.registerAdapter(
      "prefs",
      FakeDataStoreAdapter().apply {
        setStore("settings", linkedMapOf("name" to "alice", "count" to 3, "flag" to true))
      },
    )

    val response =
      successResult(
        provider.call(
          "getDataStore",
          null,
          bundleOf("adapterName" to "prefs", "storeName" to "settings"),
        )
      )

    val prefs = response as StorageResponse.Preferences
    val byKey = prefs.entries.associateBy { it.key }
    assertEquals("alice", byKey.getValue("name").value)
    assertEquals("STRING", byKey.getValue("name").type)
    assertEquals("3", byKey.getValue("count").value)
    assertEquals("INT", byKey.getValue("count").type)
    assertEquals("BOOLEAN", byKey.getValue("flag").type)
  }

  @Test
  fun `getDataStore serializes string-set and byte-array values for the wire`() {
    DataStoreInspector.registerAdapter(
      "prefs",
      FakeDataStoreAdapter().apply {
        setStore(
          "typed",
          linkedMapOf("tags" to setOf("a", "b"), "blob" to byteArrayOf(1, 2, 3)),
        )
      },
    )

    val response =
      successResult(
        provider.call(
          "getDataStore",
          null,
          bundleOf("adapterName" to "prefs", "storeName" to "typed"),
        )
      )

    val byKey = (response as StorageResponse.Preferences).entries.associateBy { it.key }
    assertEquals("STRING_SET", byKey.getValue("tags").type)
    assertEquals("[\"a\",\"b\"]", byKey.getValue("tags").value)
    assertEquals("BYTE_ARRAY", byKey.getValue("blob").type)
    // android.util.Base64.NO_WRAP encoding of {1,2,3}.
    assertEquals("AQID", byKey.getValue("blob").value)
  }

  @Test
  fun `getDataStore applies the boundary redaction policy`() {
    DataStoreInspector.registerAdapter(
      "prefs",
      FakeDataStoreAdapter().apply {
        setStore("auth", linkedMapOf("token" to "secret", "user" to "alice"))
      },
    )
    DataStoreInspector.setRedactionPolicy { _, key -> key == "token" }

    val response =
      successResult(
        provider.call(
          "getDataStore",
          null,
          bundleOf("adapterName" to "prefs", "storeName" to "auth"),
        )
      )

    val byKey = (response as StorageResponse.Preferences).entries.associateBy { it.key }
    assertEquals(DataStoreInspector.REDACTED_VALUE, byKey.getValue("token").value)
    assertEquals("alice", byKey.getValue("user").value)
  }

  @Test
  fun `unknown adapter reports a structured error`() {
    val bundle = provider.call("listDataStores", null, bundleOf("adapterName" to "missing"))

    assertFalse(bundle.getBoolean("success"))
    assertEquals("AdapterNotFound", bundle.getString("errorType"))
  }

  @Test
  fun `datastore methods are rejected when inspection is disabled`() {
    SharedPreferencesInspector.setEnabled(false)

    val bundle = provider.call("listDataStores", null, bundleOf("adapterName" to "prefs"))

    assertFalse(bundle.getBoolean("success"))
    assertEquals("DISABLED", bundle.getString("errorType"))
  }
}
