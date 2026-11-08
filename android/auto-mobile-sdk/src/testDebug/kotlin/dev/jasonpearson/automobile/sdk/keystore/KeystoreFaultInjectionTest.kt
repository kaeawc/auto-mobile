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
    inject("DELAY", delayMs = 1_000L)
    val order = mutableListOf<String>()
    val recordingBackend =
      FaultingKeystoreBackend(backend, KeystoreSleeper { order.add("$it:${backend.calls.size}") })
    assertTrue(recordingBackend.containsAlias("aes"))
    assertEquals(EntryCategory.KEY, recordingBackend.entryCategory("aes"))
    recordingBackend.deleteAlias("aes")
    assertEquals(listOf("1000:0", "1000:1", "1000:2"), order)
    assertEquals(listOf("containsAlias:aes", "entryCategory:aes", "deleteAlias:aes"), backend.calls)
    assertFalse(backend.entries.containsKey("aes"))
  }

  @Test
  fun `one call spends at most the per-call delay budget across aliases and operations`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    backend.entries["cert"] = EntryCategory.CERTIFICATE
    allowedHandler.handle("injectFault", "fixture", null, "DELAY", 3_000L)
    val result = allowedHandler.handle("delete", "fixture")
    // aes and cert each need contains + delete; the fourth delay gets only the 1000 ms left and
    // the absent aliases' lookups run undelayed, yet every alias is still attempted.
    assertEquals("partial", result.getString("status"))
    assertEquals(2, result.getInt("deletedCount"))
    assertEquals(5, result.getJSONArray("aliases").length())
    assertEquals(listOf(3_000L, 3_000L, 3_000L, 1_000L), sleeper.delays)
    assertEquals(MAX_INJECTED_DELAY_PER_CALL_MS, sleeper.delays.sum())
    // A new provider call constructs a new backend, so its budget starts full again.
    backend.entries["aes"] = EntryCategory.KEY
    val nextCall = KeystoreStateHandler(FaultingKeystoreBackend(backend, sleeper), probe) { true }
    sleeper.delays.clear()
    assertEquals("deleted", nextCall.handle("delete", "fixture", "aes").getString("status"))
    assertEquals(listOf(3_000L, 3_000L), sleeper.delays)
  }

  @Test
  fun `maximum delay is spent once per call and every operation still runs`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    inject("DELAY", delayMs = MAX_INJECTED_DELAY_PER_CALL_MS)
    assertEquals("deleted", allowedHandler.handle("delete", "fixture", "aes").getString("status"))
    assertEquals(listOf(MAX_INJECTED_DELAY_PER_CALL_MS), sleeper.delays)
    assertEquals(listOf("containsAlias:aes", "deleteAlias:aes"), backend.calls)
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
