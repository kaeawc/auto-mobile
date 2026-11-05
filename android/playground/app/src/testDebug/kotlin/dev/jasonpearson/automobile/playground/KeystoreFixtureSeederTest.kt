package dev.jasonpearson.automobile.playground

import java.io.File
import java.security.GeneralSecurityException
import java.security.ProviderException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KeystoreFixtureSeederTest {
  private class FakeStore : KeystoreFixtureStore {
    val entries = mutableMapOf<String, String>()
    val creations = mutableListOf<String>()

    override fun containsAlias(alias: String): Boolean = alias in entries

    override fun createKey(alias: String) {
      entries[alias] = "KEY"
      creations += alias
    }

    override fun createAuthBoundKey(alias: String) {
      entries[alias] = "AUTH_BOUND_KEY"
      creations += alias
    }

    override fun createCertificate(alias: String) {
      entries[alias] = "CERTIFICATE"
      creations += alias
    }
  }

  @Test
  fun seedsAllFixtureAliasesIdempotentlyWithoutTouchingOtherAliases() {
    val store = FakeStore()
    store.entries["unrelated"] = "KEY"
    val seeder = KeystoreFixtureSeeder(store)
    seeder.seed(includeAuthBoundKey = true)
    seeder.seed(includeAuthBoundKey = true)
    assertEquals(
      mapOf(
        "unrelated" to "KEY",
        "automobile.fixture" to "KEY",
        "automobile.fixture.certificate" to "CERTIFICATE",
        "automobile.fixture.auth-bound" to "AUTH_BOUND_KEY",
      ),
      store.entries,
    )
    assertEquals(
      listOf(
        "automobile.fixture",
        "automobile.fixture.certificate",
        "automobile.fixture.auth-bound",
      ),
      store.creations,
    )
  }

  @Test
  fun mapsProbeOutcomesWithoutExposingExceptionDetails() {
    assertEquals("ok", authBoundProbeOutcome(null))
    assertEquals(
      "KeyPermanentlyInvalidatedException",
      authBoundProbeOutcome(KeyPermanentlyInvalidatedException("secret details")),
    )
    assertEquals(
      "UserNotAuthenticatedException",
      authBoundProbeOutcome(UserNotAuthenticatedException("secret details")),
    )
    assertEquals("ProviderException", authBoundProbeOutcome(ProviderException("secret details")))
    assertEquals(
      "IllegalStateException",
      authBoundProbeOutcome(IllegalStateException("secret details")),
    )
    assertEquals(
      "GeneralSecurityException",
      authBoundProbeOutcome(GeneralSecurityException("secret details")),
    )
  }

  private class KeyPermanentlyInvalidatedException(message: String) :
    GeneralSecurityException(message)

  private class UserNotAuthenticatedException(message: String) : GeneralSecurityException(message)

  @Test
  fun fillsMissingCertificateWithoutRecreatingExistingKey() {
    val store = FakeStore()
    store.entries[KeystoreFixtureSeeder.KEY_ALIAS] = "KEY"
    KeystoreFixtureSeeder(store).seed(includeAuthBoundKey = true)
    assertEquals(
      listOf(KeystoreFixtureSeeder.CERTIFICATE_ALIAS, KeystoreFixtureSeeder.AUTH_BOUND_KEY_ALIAS),
      store.creations,
    )
  }

  @Test
  fun ordinarySeedLeavesAuthBoundKeyUncreated() {
    val store = FakeStore()
    KeystoreFixtureSeeder(store).seed()
    assertEquals(
      mapOf(
        KeystoreFixtureSeeder.KEY_ALIAS to "KEY",
        KeystoreFixtureSeeder.CERTIFICATE_ALIAS to "CERTIFICATE",
      ),
      store.entries,
    )
    assertEquals(
      listOf(KeystoreFixtureSeeder.KEY_ALIAS, KeystoreFixtureSeeder.CERTIFICATE_ALIAS),
      store.creations,
    )
  }

  @Test
  fun mainActivityDeclaresExactlyTheFixtureAliasesInsideDebugGuard() {
    val source =
      File("src/main/kotlin/dev/jasonpearson/automobile/playground/MainActivity.kt").readText()
    assertTrue(
      source.contains(
        """if (BuildConfig.DEBUG) {
      KeystoreTestState.declareScope(
        "fixture",
        setOf("automobile.fixture", "automobile.fixture.certificate"),
      )""",
      ),
    )
  }
}
