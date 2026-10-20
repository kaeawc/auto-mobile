package dev.jasonpearson.automobile.ctrlproxy.prototype

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

  @Test
  fun `shared spec capabilities are supported`() {
    val missing = requiredCapabilities - AutoMobilePrototype.capabilities
    assertTrue("Renderer is missing spec capabilities: $missing", missing.isEmpty())
  }

  @Test
  fun `capabilities are sorted`() {
    val capabilities = AutoMobilePrototype.capabilities.toList()
    assertEquals(capabilities.sorted(), capabilities)
  }
}
