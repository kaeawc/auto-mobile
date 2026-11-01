package dev.jasonpearson.automobile.playground

import java.io.File
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

    override fun createCertificate(alias: String) {
      entries[alias] = "CERTIFICATE"
      creations += alias
    }
  }

  @Test
  fun seedsBothCategoriesIdempotentlyWithoutTouchingOtherAliases() {
    val store = FakeStore()
    store.entries["unrelated"] = "KEY"
    val seeder = KeystoreFixtureSeeder(store)
    seeder.seed()
    seeder.seed()
    assertEquals(
      mapOf(
        "unrelated" to "KEY",
        "automobile.fixture" to "KEY",
        "automobile.fixture.certificate" to "CERTIFICATE",
      ),
      store.entries,
    )
    assertEquals(listOf("automobile.fixture", "automobile.fixture.certificate"), store.creations)
  }

  @Test
  fun fillsMissingCertificateWithoutRecreatingExistingKey() {
    val store = FakeStore()
    store.entries[KeystoreFixtureSeeder.KEY_ALIAS] = "KEY"
    KeystoreFixtureSeeder(store).seed()
    assertEquals(listOf(KeystoreFixtureSeeder.CERTIFICATE_ALIAS), store.creations)
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
