package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.ProviderException
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// StrongBox key generation (setIsStrongBoxBacked) exists from API 28; the default SDK is older.
@Config(sdk = [28])
@RunWith(RobolectricTestRunner::class)
internal class KeystoreStrongBoxFaultTest : KeystoreFaultTestBase() {
  @After
  fun clearGate() {
    KeystoreTestState.keyGenerationGate = null
  }

  private fun spec(alias: String = "aes", strongBox: Boolean = true): KeyGenParameterSpec =
    KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setIsStrongBoxBacked(strongBox)
      .build()

  private fun assertStrongBoxUnavailable(spec: KeyGenParameterSpec) {
    try {
      KeystoreTestState.checkKeyGeneration(spec)
      fail("Expected StrongBoxUnavailableException")
    } catch (expected: StrongBoxUnavailableException) {
      // The platform type apps already catch: a ProviderException with no exception text.
      assertTrue(expected is ProviderException)
      assertNull(expected.message)
    }
  }

  @Test
  fun `armed alias fails StrongBox key generation and echoes the kind`() {
    enable()
    val result = inject("STRONGBOX_UNAVAILABLE")
    assertEquals("ok", result.getString("outcome"))
    assertEquals("STRONGBOX_UNAVAILABLE", result.getString("requestedKind"))
    assertStrongBoxUnavailable(spec())
    // Persists until cleared, so a retry with StrongBox fails the same way.
    assertStrongBoxUnavailable(spec())
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `fallback without StrongBox and other aliases generate normally`() {
    enable()
    inject("STRONGBOX_UNAVAILABLE")
    KeystoreTestState.checkKeyGeneration(spec(strongBox = false))
    KeystoreTestState.checkKeyGeneration(spec("private"))
    KeystoreTestState.checkKeyGeneration(spec("undeclared"))
    assertTrue(backend.calls.isEmpty())
  }

  @Test
  fun `scope selection arms every declared alias`() {
    enable()
    val result = allowedHandler.handle("injectFault", "fixture", kind = "STRONGBOX_UNAVAILABLE")
    assertEquals("ok", result.getString("outcome"))
    assertStrongBoxUnavailable(spec("aes"))
    assertStrongBoxUnavailable(spec("private"))
  }

  @Test
  fun `metadata and deletion ignore the StrongBox fault`() {
    enable()
    backend.entries["aes"] = EntryCategory.KEY
    inject("STRONGBOX_UNAVAILABLE")
    val metadata = metadata()
    assertEquals("ok", metadata.getString("outcome"))
    assertTrue(metadata.getJSONArray("entries").getJSONObject(0).getBoolean("present"))
    assertEquals("deleted", allowedHandler.handle("delete", "fixture", "aes").getString("status"))
    assertTrue(sleeper.delays.isEmpty())
  }

  @Test
  fun `another kind replaces the StrongBox fault for that alias`() {
    enable()
    inject("STRONGBOX_UNAVAILABLE")
    inject("PROVIDER_EXCEPTION")
    KeystoreTestState.checkKeyGeneration(spec())
    assertEquals("unavailable", metadata().getString("outcome"))
  }

  @Test
  fun `clearing, disabling, or unregistering the alias stops the fault`() {
    enable()
    inject("STRONGBOX_UNAVAILABLE")
    assertEquals("ok", allowedHandler.handle("clearFaults", "fixture", "aes").getString("outcome"))
    KeystoreTestState.checkKeyGeneration(spec())

    inject("STRONGBOX_UNAVAILABLE")
    KeystoreTestState.setEnabled(false)
    KeystoreTestState.checkKeyGeneration(spec())
    KeystoreTestState.setEnabled(true)
    KeystoreTestState.checkKeyGeneration(spec())

    val registration = KeystoreTestState.declareScope("temporary", setOf("temporaryAlias"))
    allowedHandler.handle("injectFault", "temporary", "temporaryAlias", "STRONGBOX_UNAVAILABLE")
    registration.unregister()
    KeystoreTestState.checkKeyGeneration(spec("temporaryAlias"))
  }

  @Test
  fun `refused injections leave key generation untouched`() {
    enable()
    assertRefusal(
      deniedHandler.handle("injectFault", "fixture", "aes", "STRONGBOX_UNAVAILABLE"),
      "authorization_denied",
      "MUTATION_NOT_ALLOWED",
    )
    assertRefusal(
      allowedHandler.handle("injectFault", "fixture", "aes", "strongbox_unavailable"),
      "invalid_selector",
      "INVALID_FAULT",
    )
    KeystoreTestState.checkKeyGeneration(spec())
  }

  @Test
  fun `without the debug gate key generation is never failed`() {
    enable()
    inject("STRONGBOX_UNAVAILABLE")
    // Release builds never install the gate; the armed plan is then unreachable.
    KeystoreTestState.keyGenerationGate = null
    KeystoreTestState.checkKeyGeneration(spec())
  }
}
