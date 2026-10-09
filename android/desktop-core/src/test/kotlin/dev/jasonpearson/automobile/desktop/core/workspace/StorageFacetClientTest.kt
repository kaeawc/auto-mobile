package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.DesktopInputAllocation
import dev.jasonpearson.automobile.desktop.core.datasource.RealStorageDataSource
import dev.jasonpearson.automobile.desktop.core.datasource.Result
import dev.jasonpearson.automobile.desktop.core.storage.KeyValueType
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking

/**
 * #10977: the Storage facet's edits were sessionless, so the daemon refused them on a device the
 * user's own desktop session held and never claimed a free one. The facet's client now allocates
 * the pane's device and carries the desktop session for edits; browsing still only watches.
 */
class StorageFacetClientTest {
  private val client = FakeAutoMobileClient()
  private val allocations = mutableListOf<String>()
  private var allowed = true
  private val allocation = DesktopInputAllocation { deviceId ->
    allocations += "$deviceId@${client.calls.count { it == "setKeyValue" }}"
    allowed
  }

  private fun source(allocation: DesktopInputAllocation?) =
    RealStorageDataSource(
      storageClientProvider({ client }, allocation) { "desktop-session" },
      deviceId = "emulator-5554",
      packageName = "com.example",
      platform = StoragePlatform.Android,
    )

  @Test
  fun `an edit allocates the pane's device first and carries the desktop session`() = runBlocking {
    val result = source(allocation).setKeyValue("prefs.xml", "k", "v", KeyValueType.String)

    assertTrue(result is Result.Success)
    assertEquals(listOf("emulator-5554@0"), allocations)
    assertEquals("desktop-session", client.setKeyValueCalls.single().sessionUuid)
  }

  @Test
  fun `a refused allocation sends nothing`() = runBlocking {
    allowed = false

    val result = source(allocation).setKeyValue("prefs.xml", "k", "v", KeyValueType.String)

    assertTrue(result is Result.Error)
    assertTrue(client.setKeyValueCalls.isEmpty())
  }

  @Test
  fun `removing a key and clearing a file allocate and carry the session too`() = runBlocking {
    source(allocation).removeKeyValue("prefs.xml", "k")
    source(allocation).clearKeyValueFile("prefs.xml")

    assertEquals(2, allocations.size)
    assertEquals("desktop-session", client.removeKeyValueCalls.single().sessionUuid)
    assertEquals("desktop-session", client.clearKeyValueFileCalls.single().sessionUuid)
  }

  @Test
  fun `browsing reads allocate nothing`() = runBlocking {
    source(allocation).getKeyValueFiles()
    source(allocation).getDatabases()

    assertTrue(allocations.isEmpty())
  }

  @Test
  fun `without an allocation the base client is used unchanged`() = runBlocking {
    source(null).setKeyValue("prefs.xml", "k", "v", KeyValueType.String)

    assertTrue(allocations.isEmpty())
    assertEquals(null, client.setKeyValueCalls.single().sessionUuid)
  }
}
