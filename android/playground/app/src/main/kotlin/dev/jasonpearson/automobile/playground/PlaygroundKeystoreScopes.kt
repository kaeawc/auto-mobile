package dev.jasonpearson.automobile.playground

import dev.jasonpearson.automobile.sdk.keystore.KeystoreTestState

/**
 * Keystore scopes the Playground declares to the debug SDK, so its provider and `resetKeychain` can
 * address the fixture aliases. The auth-bound key has its own scope so that deleting scope
 * `fixture` keeps its two-alias count, and so it can be reset or inspected without touching the
 * ordinary fixture entries.
 */
internal object PlaygroundKeystoreScopes {
  const val FIXTURE_SCOPE = "fixture"
  const val FIXTURE_AUTH_SCOPE = "fixture-auth"

  val scopes: Map<String, Set<String>> =
    mapOf(
      FIXTURE_SCOPE to setOf("automobile.fixture", "automobile.fixture.certificate"),
      FIXTURE_AUTH_SCOPE to setOf("automobile.fixture.auth-bound"),
    )

  fun declare(
    declareScope: (String, Set<String>) -> Unit = { name, aliases ->
      KeystoreTestState.declareScope(name, aliases)
    },
  ) {
    for ((name, aliases) in scopes) declareScope(name, aliases)
  }
}
