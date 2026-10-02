package dev.jasonpearson.automobile.sdk.keystore

import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class KeystoreTestStateTest {
  @Before
  fun setUp() {
    KeystoreTestState.reset()
  }

  @After
  fun tearDown() {
    KeystoreTestState.reset()
  }

  @Test
  fun `disabled by default and explicit enable toggles`() {
    assertFalse(KeystoreTestState.isEnabled())
    KeystoreTestState.setEnabled(true)
    assertTrue(KeystoreTestState.isEnabled())
    KeystoreTestState.setEnabled(false)
    assertFalse(KeystoreTestState.isEnabled())
  }

  @Test
  fun `scope is an exact defensive copy and registration removes it`() {
    val aliases = mutableSetOf("auth", "auth.two")
    val registration = KeystoreTestState.declareScope("fixture", aliases)
    aliases.add("auth.three")
    assertEquals(setOf("auth", "auth.two"), KeystoreTestState.aliasesForScope("fixture"))
    assertNull(KeystoreTestState.aliasesForScope("fix"))
    assertTrue(registration.unregister())
    assertFalse(registration.unregister())
    assertNull(KeystoreTestState.aliasesForScope("fixture"))
  }

  @Test
  fun `stale registration cannot remove an equal replacement`() {
    val old = KeystoreTestState.declareScope("fixture", setOf("auth"))
    val current = KeystoreTestState.declareScope("fixture", setOf("auth"))
    assertFalse(old.unregister())
    assertTrue(current.unregister())
  }

  @Test
  fun `reset clears opt in and scopes`() {
    KeystoreTestState.setEnabled(true)
    val old = KeystoreTestState.declareScope("fixture", setOf("auth"))
    KeystoreTestState.reset()
    assertFalse(KeystoreTestState.isEnabled())
    assertTrue(KeystoreTestState.declaredScopes().isEmpty())
    assertFalse(old.unregister())
  }

  @Test(expected = IllegalArgumentException::class)
  fun `blank scope rejected`() {
    KeystoreTestState.declareScope(" ", setOf("auth"))
  }

  @Test(expected = IllegalArgumentException::class)
  fun `empty alias set rejected`() {
    KeystoreTestState.declareScope("fixture", emptySet())
  }

  @Test(expected = IllegalArgumentException::class)
  fun `blank alias rejected`() {
    KeystoreTestState.declareScope("fixture", setOf(" "))
  }
}
