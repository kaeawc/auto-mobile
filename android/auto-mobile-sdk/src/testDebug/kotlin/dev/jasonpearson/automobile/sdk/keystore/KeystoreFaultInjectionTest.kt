package dev.jasonpearson.automobile.sdk.keystore

import java.security.ProviderException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class KeystoreFaultInjectionTest : KeystoreFaultTestBase() {
  @Test
  fun `authentication fault maps metadata without reaching backend`() {
    enable()
    val result = inject("USER_NOT_AUTHENTICATED")
    assertEquals("ok", result.getString("outcome"))
    assertEquals("authentication_required", metadata().getString("outcome"))
    assertEquals("AUTHENTICATION_REQUIRED", metadata().getString("reason"))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `provider fault maps metadata and is shared between handlers`() {
    enable()
    inject("PROVIDER_EXCEPTION")
    val anotherHandler = KeystoreStateHandler(FaultingKeystoreBackend(backend, sleeper), probe)
    val result = anotherHandler.handle("metadata", "fixture", "aes")
    assertRefusal(result, "unavailable", "KEYSTORE_UNAVAILABLE")
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `keystore fault maps delete to failed without deleting`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    inject("KEY_STORE_EXCEPTION")
    val result = allowedHandler.handle("delete", "fixture", "aes")
    assertEquals("ok", result.getString("outcome"))
    assertEquals("failed", result.getString("status"))
    assertEquals("failed", result.getJSONArray("aliases").getJSONObject(0).getString("outcome"))
    assertEquals(0, result.getInt("deletedCount"))
    assertEquals(EntryCategory.KEY, backend.entries["aes"])
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `delay precedes each backend operation without sleeping`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    inject("DELAY", delayMs = 10_000L)
    val order = mutableListOf<String>()
    val recordingBackend =
      FaultingKeystoreBackend(backend, KeystoreSleeper { order.add("$it:${backend.calls.size}") })
    assertTrue(recordingBackend.containsAlias("aes"))
    assertEquals(EntryCategory.KEY, recordingBackend.entryCategory("aes"))
    recordingBackend.deleteAlias("aes")
    assertEquals(listOf("10000:0", "10000:1", "10000:2"), order)
    assertEquals(listOf("containsAlias:aes", "entryCategory:aes", "deleteAlias:aes"), backend.calls)
    assertFalse(backend.entries.containsKey("aes"))
  }

  @Test
  fun `metadata and delete each record delays for their backend operations`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    inject("DELAY", delayMs = 1L)
    assertEquals("ok", metadata().getString("outcome"))
    assertEquals("deleted", allowedHandler.handle("delete", "fixture", "aes").getString("status"))
    assertEquals(listOf(1L, 1L, 1L, 1L), sleeper.delays)
  }

  @Test
  fun `exception decoration covers category and deletion directly`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    inject("PROVIDER_EXCEPTION")
    for (operation in
      listOf<() -> Unit>(
        { faultingBackend.containsAlias("aes") },
        { faultingBackend.entryCategory("aes") },
        { faultingBackend.deleteAlias("aes") },
      )) {
      try {
        operation()
        fail("Expected injected provider exception")
      } catch (expected: ProviderException) {
        assertNull(expected.message)
      }
    }
    assertTrue(backend.calls.isEmpty())
  }
}
