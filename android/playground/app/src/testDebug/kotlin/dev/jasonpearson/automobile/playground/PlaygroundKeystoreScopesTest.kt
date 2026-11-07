package dev.jasonpearson.automobile.playground

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaygroundKeystoreScopesTest {
  @Test
  fun fixtureScopeKeepsExactlyTheTwoOrdinaryFixtureAliases() {
    assertEquals(
      setOf(KeystoreFixtureSeeder.KEY_ALIAS, KeystoreFixtureSeeder.CERTIFICATE_ALIAS),
      PlaygroundKeystoreScopes.scopes[PlaygroundKeystoreScopes.FIXTURE_SCOPE],
    )
  }

  @Test
  fun authBoundAliasIsDeclaredInItsOwnScope() {
    assertEquals(
      setOf(KeystoreFixtureSeeder.AUTH_BOUND_KEY_ALIAS),
      PlaygroundKeystoreScopes.scopes[PlaygroundKeystoreScopes.FIXTURE_AUTH_SCOPE],
    )
  }

  @Test
  fun everySeededAliasIsReachableThroughADeclaredScope() {
    assertEquals(
      setOf(
        KeystoreFixtureSeeder.KEY_ALIAS,
        KeystoreFixtureSeeder.CERTIFICATE_ALIAS,
        KeystoreFixtureSeeder.AUTH_BOUND_KEY_ALIAS,
        KeystoreStrongBoxProbe.ALIAS,
      ),
      PlaygroundKeystoreScopes.scopes.values.flatten().toSet(),
    )
  }

  @Test
  fun strongBoxProbeAliasIsDeclaredInItsOwnScope() {
    assertEquals(
      setOf(KeystoreStrongBoxProbe.ALIAS),
      PlaygroundKeystoreScopes.scopes[PlaygroundKeystoreScopes.FIXTURE_STRONGBOX_SCOPE],
    )
  }

  @Test
  fun declareRegistersEveryScopeWithTheirAliases() {
    val declared = mutableMapOf<String, Set<String>>()
    PlaygroundKeystoreScopes.declare { name, aliases -> declared[name] = aliases }
    assertEquals(
      mapOf(
        "fixture" to setOf("automobile.fixture", "automobile.fixture.certificate"),
        "fixture-auth" to setOf("automobile.fixture.auth-bound"),
        "fixture-strongbox" to setOf("automobile.fixture.strongbox"),
      ),
      declared,
    )
  }
}
