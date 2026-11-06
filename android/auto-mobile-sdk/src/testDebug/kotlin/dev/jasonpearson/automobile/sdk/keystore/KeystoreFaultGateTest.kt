package dev.jasonpearson.automobile.sdk.keystore

import java.security.KeyStoreException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class KeystoreFaultGateTest : KeystoreFaultTestBase() {
  @Test
  fun `both fault methods use delete gates before backend or probe access`() {
    for (method in listOf("injectFault", "clearFaults")) {
      assertRefusal(
        allowedHandler.handle(method, "fixture", "aes", "PROVIDER_EXCEPTION"),
        "disabled",
        "DISABLED",
      )
    }
    enable()
    inject("PROVIDER_EXCEPTION")
    for (method in listOf("injectFault", "clearFaults")) {
      assertRefusal(
        deniedHandler.handle(method, "fixture", "aes", "DELAY", 1L),
        "authorization_denied",
        "MUTATION_NOT_ALLOWED",
      )
    }
    assertTrue(backend.calls.isEmpty())
    assertEquals(0, probe.calls)
    assertEquals("unavailable", metadata().getString("outcome"))
    assertTrue(sleeper.delays.isEmpty())
  }

  @Test
  fun `undeclared scopes and exact aliases are refused for both fault methods`() {
    enable()
    KeystoreTestState.declareScope("other", setOf("external"))
    for (method in listOf("injectFault", "clearFaults")) {
      for ((scope, alias) in
        listOf("absent" to "aes", "fixture" to "external", null to "aes.child", null to "*")) {
        assertRefusal(
          allowedHandler.handle(method, scope, alias, "PROVIDER_EXCEPTION"),
          "scope_not_declared",
          "SCOPE_NOT_DECLARED",
        )
      }
    }
    assertFalse(KeystoreFaultPlan.inject(listOf("aes", "foreign"), "PROVIDER_EXCEPTION", null))
    assertEquals("ok", metadata().getString("outcome"))
    assertEquals(listOf("containsAlias:aes"), backend.calls)
  }

  @Test
  fun `empty selectors are refused even while disabled`() {
    for (method in listOf("injectFault", "clearFaults")) {
      for (selector in listOf(null, "", " ")) {
        assertRefusal(
          allowedHandler.handle(method, selector, selector, "PROVIDER_EXCEPTION"),
          "invalid_selector",
          "EMPTY_SELECTOR",
        )
      }
    }
    assertEquals(0, probe.calls)
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `invalid kinds and delays are refused without replacing existing faults`() {
    enable()
    inject("PROVIDER_EXCEPTION")
    for (kind in listOf(null, "", "provider_exception", "UNKNOWN")) {
      assertRefusal(
        allowedHandler.handle("injectFault", "fixture", "aes", kind),
        "invalid_selector",
        "INVALID_FAULT",
      )
    }
    for (delay in listOf(null, Long.MIN_VALUE, -1L, 0L, 10_001L, Long.MAX_VALUE)) {
      assertRefusal(inject("DELAY", delayMs = delay), "invalid_selector", "INVALID_FAULT")
    }
    assertEquals(0, probe.calls)
    assertTrue(backend.calls.isEmpty())
    assertEquals("unavailable", metadata().getString("outcome"))
    assertTrue(sleeper.delays.isEmpty())
  }

  @Test
  fun `new fault replaces old fault for that alias only`() {
    enable()
    inject("PROVIDER_EXCEPTION", "cert")
    inject("PROVIDER_EXCEPTION")
    inject("DELAY", delayMs = 5L)
    assertEquals("ok", metadata().getString("outcome"))
    assertEquals(listOf(5L), sleeper.delays)
    assertEquals("unavailable", metadata("cert").getString("outcome"))
    assertEquals(listOf("containsAlias:aes"), backend.calls)
  }

  @Test
  fun `scope selection and clear one or all selected aliases preserve other scopes`() {
    enable()
    KeystoreTestState.declareScope("other", setOf("external"))
    assertEquals(
      "ok",
      allowedHandler
        .handle("injectFault", "fixture", kind = "PROVIDER_EXCEPTION")
        .getString("outcome"),
    )
    allowedHandler.handle("injectFault", alias = "external", kind = "PROVIDER_EXCEPTION")
    assertEquals("unavailable", metadata("cert").getString("outcome"))
    assertEquals("ok", allowedHandler.handle("clearFaults", alias = "aes").getString("outcome"))
    assertEquals("ok", metadata().getString("outcome"))
    assertEquals("unavailable", metadata("cert").getString("outcome"))
    assertEquals("ok", allowedHandler.handle("clearFaults", "fixture").getString("outcome"))
    assertEquals("ok", metadata("cert").getString("outcome"))
    assertEquals("unavailable", allowedHandler.handle("metadata", "other").getString("outcome"))
    KeystoreFaultPlan.clearAll()
    assertEquals("ok", allowedHandler.handle("metadata", "other").getString("outcome"))
  }

  @Test
  fun `disabled backend operation discards entire plan and never applies delays`() {
    enable()
    inject("DELAY", delayMs = 10_000L)
    inject("PROVIDER_EXCEPTION", "cert")
    KeystoreTestState.setEnabled(false)
    assertFalse(faultingBackend.containsAlias("aes"))
    KeystoreTestState.setEnabled(true)
    assertEquals("ok", metadata().getString("outcome"))
    assertEquals("ok", metadata("cert").getString("outcome"))
    assertTrue(sleeper.delays.isEmpty())
  }

  @Test
  fun `disabled discovery clears faults without backend access`() {
    enable()
    inject("PROVIDER_EXCEPTION")
    KeystoreTestState.setEnabled(false)
    assertEquals("disabled", allowedHandler.handle("discover").getString("outcome"))
    assertTrue(backend.calls.isEmpty())
    KeystoreTestState.setEnabled(true)
    assertEquals("ok", metadata().getString("outcome"))
  }

  @Test
  fun `reset clears faults when observed before redeclaration`() {
    enable()
    inject("PROVIDER_EXCEPTION")
    KeystoreTestState.reset()
    assertEquals("disabled", metadata().getString("outcome"))
    enable()
    assertEquals("ok", metadata().getString("outcome"))
  }

  @Test
  fun `unregistered alias cannot retain an active fault`() {
    enable()
    val registration = KeystoreTestState.declareScope("temporary", setOf("temporaryAlias"))
    allowedHandler.handle("injectFault", "temporary", "temporaryAlias", "PROVIDER_EXCEPTION")
    registration.unregister()
    assertFalse(faultingBackend.containsAlias("temporaryAlias"))
    KeystoreTestState.declareScope("temporary", setOf("temporaryAlias"))
    assertEquals("ok", allowedHandler.handle("metadata", "temporary").getString("outcome"))
  }

  @Test
  fun `fault envelopes echo identifiers and never return exception text or material`() {
    enable()
    val injected = inject("KEY_STORE_EXCEPTION")
    assertEquals(
      setOf(
        "schemaVersion",
        "capability",
        "bridgeAvailable",
        "requestedScope",
        "requestedAlias",
        "requestedKind",
        "outcome",
      ),
      injected.keys().asSequence().toSet(),
    )
    assertEquals(1, injected.getInt("schemaVersion"))
    assertEquals("storage.keystore", injected.getString("capability"))
    assertTrue(injected.getBoolean("bridgeAvailable"))
    assertEquals("fixture", injected.getString("requestedScope"))
    assertEquals("aes", injected.getString("requestedAlias"))
    assertEquals("KEY_STORE_EXCEPTION", injected.getString("requestedKind"))
    val faulted = metadata()
    val cleared = allowedHandler.handle("clearFaults", "fixture", "aes")
    backend.failure = KeyStoreException("sensitive exception text and secret key bytes")
    for (result in
      listOf(
        injected,
        faulted,
        cleared,
        metadata(),
        allowedHandler.handle("delete", "fixture", "aes"),
      )) {
      val json = result.toString()
      assertFalse(json.contains("sensitive exception text"))
      assertFalse(json.contains("secret key bytes"))
      assertFalse(json.contains("java.security"))
      assertFalse(json.contains("android.security"))
      assertFalse(json.contains("User not authenticated"))
      assertFalse(result.has("message"))
      assertFalse(result.has("exception"))
      assertFalse(result.has("keyMaterial"))
    }
  }
}
