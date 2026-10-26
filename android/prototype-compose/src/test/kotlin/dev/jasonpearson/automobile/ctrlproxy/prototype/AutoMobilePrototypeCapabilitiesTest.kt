package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.AutoMobilePrototype
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class AutoMobilePrototypeCapabilitiesTest {
  companion object {
    private lateinit var requiredCapabilities: Set<String>

    @JvmStatic
    @BeforeClass
    fun loadFixture() {
      val fixture =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-capabilities/spec-capabilities.json") }
          .first { it.isFile }
      requiredCapabilities =
        Json.parseToJsonElement(fixture.readText())
          .jsonArray
          .map { it.jsonPrimitive.content }
          .toSet()
    }
  }

  /**
   * The test module is a placeholder no production runtime advertises. `window.backdrop` (#15126)
   * validates but is drawn by no renderer until the Kotlin slice lands.
   */
  private val exclusions = setOf("prototype_platform_test_v1", "prototype_backdrop_v1")

  @Test
  fun `shared spec capabilities are supported`() {
    assertTrue(
      "Exclusions must name current spec gates",
      requiredCapabilities.containsAll(exclusions),
    )
    assertTrue(
      "Remove exclusions once supported",
      exclusions.none { it in AutoMobilePrototype.capabilities },
    )
    val missing = requiredCapabilities - AutoMobilePrototype.capabilities - exclusions
    assertTrue("Renderer is missing spec capabilities: $missing", missing.isEmpty())
  }

  @Test
  fun `capabilities are sorted`() {
    val capabilities = AutoMobilePrototype.capabilities.toList()
    assertEquals(capabilities.sorted(), capabilities)
  }
}
