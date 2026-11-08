package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** The map `backend` capabilities (#14309) come from node positions in both collectors. */
class PrototypeMapBackendTest {
  private val backends =
    setOf("prototype_platform_map_google_v1", "prototype_platform_map_maplibre_v1")

  private fun found(name: String): Pair<Set<String>, Set<String>> {
    val input = fixtureDirectory().resolve("valid/$name").readText()
    val strict = PrototypeStrictPolicy.required(Json.parseToJsonElement(input).jsonObject)
    val bundle =
      PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(input.toByteArray()))
    return strict.filter { it in backends }.toSet() to bundle.filter { it in backends }.toSet()
  }

  @Test
  fun `both collectors require each non-default backend a map node names`() {
    assertEquals(backends to backends, found("map-backends.json"))
  }

  @Test
  fun `a map-shaped channel literal is data and needs no backend`() {
    assertEquals(
      emptySet<String>() to emptySet<String>(),
      found("map-backend-channel-literal.json"),
    )
  }
}
