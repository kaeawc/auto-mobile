package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class KeystoreStateHandlerUsabilityTest : KeystoreStateHandlerTestBase() {
  @Test
  fun `invalidated auth-bound key reports authentication_required instead of present`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    backend.usabilityFailures["aes"] = KeyPermanentlyInvalidatedException("secret detail")
    val json = handler.handle("metadata", "fixture", "aes")
    assertEquals("authentication_required", json.getString("outcome"))
    assertEquals("AUTHENTICATION_REQUIRED", json.getString("reason"))
    assertFalse(json.has("entries"))
    assertFalse(json.toString().contains("secret detail"))
    assertEquals(
      listOf("containsAlias:aes", "entryCategory:aes", "verifyUsable:aes"),
      backend.calls,
    )
  }

  @Test
  fun `unauthenticated auth-bound key reports authentication_required`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    backend.usabilityFailures["aes"] = UserNotAuthenticatedException()
    val json = handler.handle("metadata", "fixture", "aes")
    assertEquals("authentication_required", json.getString("outcome"))
    assertEquals("AUTHENTICATION_REQUIRED", json.getString("reason"))
  }

  @Test
  fun `usable key stays ok and absent keys are never checked`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    val present = handler.handle("metadata", "fixture", "aes")
    assertEquals("ok", present.getString("outcome"))
    assertTrue(present.getJSONArray("entries").getJSONObject(0).getBoolean("present"))
    backend.calls.clear()
    val absent = handler.handle("metadata", "fixture", "missing")
    assertEquals("ok", absent.getString("outcome"))
    assertEquals(listOf("containsAlias:missing"), backend.calls)
  }

  @Test
  fun `one invalidated alias in a scope makes the scope read authentication_required`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    backend.entries["private"] = EntryCategory.KEY
    backend.usabilityFailures["private"] = KeyPermanentlyInvalidatedException()
    val json = handler.handle("metadata", "fixture")
    assertEquals("authentication_required", json.getString("outcome"))
    assertFalse(json.has("entries"))
  }

  @Test
  fun `faulting decorator delegates the usability check without applying a second fault`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    backend.usabilityFailures["aes"] = KeyPermanentlyInvalidatedException()
    val sleeps = mutableListOf<Long>()
    val decorated = FaultingKeystoreBackend(backend) { sleeps.add(it) }
    val json = KeystoreStateHandler(decorated, probe).handle("metadata", "fixture", "aes")
    assertEquals("authentication_required", json.getString("outcome"))
    assertEquals(listOf("verifyUsable:aes"), backend.calls.filter { it.startsWith("verify") })
    assertTrue(sleeps.isEmpty())
  }
}
