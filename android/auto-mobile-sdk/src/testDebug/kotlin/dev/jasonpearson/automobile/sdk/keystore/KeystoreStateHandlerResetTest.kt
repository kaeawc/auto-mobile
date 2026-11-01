package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import java.security.KeyStoreException
import java.security.UnrecoverableKeyException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class KeystoreStateHandlerResetTest : KeystoreStateHandlerTestBase() {
  private val allowedHandler = KeystoreStateHandler(backend, probe) { true }

  @Test
  fun `empty selector is rejected before probing or backend access`() {
    val result = allowedHandler.handle("delete")
    assertEquals("invalid_selector", result.getString("outcome"))
    assertFalse(result.has("aliases"))
    assertTrue(backend.calls.isEmpty())
    assertEquals(0, probe.calls)
  }

  @Test
  fun `disabled and mutation gate deny without per alias results`() {
    assertEquals("disabled", allowedHandler.handle("delete", "fixture").getString("outcome"))
    enable()
    val result = handler.handle("delete", "fixture")
    assertEquals("authorization_denied", result.getString("outcome"))
    assertFalse(result.has("aliases"))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `undeclared scope and aliases never touch backend`() {
    enable()
    for ((scope, alias) in listOf("other" to null, "fixture" to "foreign", null to "foreign")) {
      val result = allowedHandler.handle("delete", scope, alias)
      assertEquals("scope_not_declared", result.getString("outcome"))
      assertFalse(result.has("aliases"))
    }
    KeystoreTestState.declareScope("anotherScope", setOf("external"))
    assertEquals(
      "scope_not_declared",
      allowedHandler.handle("delete", "fixture", "external").getString("outcome"),
    )
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `scope reset deletes only exact registered aliases and returns no material`() {
    KeystoreTestState.declareScope("login", setOf("a", "b"))
    KeystoreTestState.declareScope("other", setOf("c"))
    KeystoreTestState.setEnabled(true)
    backend.entries.putAll(
      mapOf("a" to EntryCategory.KEY, "b" to EntryCategory.CERTIFICATE, "c" to EntryCategory.KEY),
    )
    val result = allowedHandler.handle("delete", "login")
    assertEquals("deleted", result.getString("status"))
    assertEquals(2, result.getInt("deletedCount"))
    assertEquals(setOf("c"), backend.entries.keys)
    assertEquals(
      setOf(
        "schemaVersion",
        "capability",
        "bridgeAvailable",
        "requestedScope",
        "deletedCount",
        "outcome",
        "status",
        "aliases",
      ),
      result.keys().asSequence().toSet(),
    )
    val entry = result.getJSONArray("aliases").getJSONObject(0)
    assertEquals(setOf("alias", "outcome"), entry.keys().asSequence().toSet())
  }

  @Test
  fun `alias alone resolves across declared scopes`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    val result = allowedHandler.handle("delete", alias = "aes")
    assertEquals("deleted", result.getString("status"))
    assertEquals("aes", result.getString("requestedAlias"))
    assertEquals(listOf("containsAlias:aes", "deleteAlias:aes"), backend.calls)
  }

  @Test
  fun `missing alias is checked before deletion`() {
    enable()
    val result = allowedHandler.handle("delete", "fixture", "missing")
    assertEquals("not_found", result.getJSONArray("aliases").getJSONObject(0).getString("outcome"))
    assertEquals("failed", result.getString("status"))
    assertEquals(listOf("containsAlias:missing"), backend.calls)
  }

  @Test
  fun `every alias attempted despite failures with correct exception mappings`() {
    val failures =
      listOf(
        UserNotAuthenticatedException() to "authentication_required",
        KeyPermanentlyInvalidatedException() to "authentication_required",
        UnrecoverableKeyException() to "locked",
        KeyStoreException() to "locked",
        IllegalStateException("sensitive text") to "failed",
      )
    probe.locked = DeviceLockState.LOCKED
    failures.forEachIndexed { index, (failure, expected) ->
      val alias = "bad$index"
      KeystoreTestState.declareScope("scope$index", setOf("good$index", alias))
      KeystoreTestState.setEnabled(true)
      backend.entries["good$index"] = EntryCategory.KEY
      backend.entries[alias] = EntryCategory.KEY
      backend.aliasFailures[alias] = failure
      val result = allowedHandler.handle("delete", "scope$index")
      assertEquals("partial", result.getString("status"))
      assertEquals(1, result.getInt("deletedCount"))
      assertEquals(expected, result.getJSONArray("aliases").getJSONObject(0).getString("outcome"))
      assertFalse(result.toString().contains("sensitive text"))
      assertTrue(backend.calls.contains("deleteAlias:good$index"))
    }
  }

  @Test
  fun `keystore failures without locked probe are failed`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    for (failure in listOf(UnrecoverableKeyException(), KeyStoreException())) {
      backend.aliasFailures["aes"] = failure
      val result = allowedHandler.handle("delete", "fixture", "aes")
      assertEquals("failed", result.getJSONArray("aliases").getJSONObject(0).getString("outcome"))
    }
  }
}
