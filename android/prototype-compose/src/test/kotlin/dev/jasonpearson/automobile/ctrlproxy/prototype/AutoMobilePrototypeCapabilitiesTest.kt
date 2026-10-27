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
   * The test module is a placeholder no production runtime advertises. No platform-namespace field
   * (#15257) has a renderer yet. `window.backdrop` (#15126) is a window-level blur only CtrlProxy's
   * overlay window can draw (the embedded renderer has no window). CtrlProxy registers the haptics
   * and sound platform modules (#14329); the embedded renderer leaves them to the app.
   */
  private val exclusions =
    setOf(
      "prototype_platform_test_v1",
      "prototype_backdrop_v1",
      "prototype_platform_namespace_v1",
      "prototype_platform_haptics_v1",
      "prototype_platform_sound_v1",
    )
  /**
   * The test module is a placeholder no production runtime advertises. `imageAsset.data` (#14192)
   * has a validated contract and no media store yet.
   */
  private val exclusions = setOf("prototype_platform_test_v1", "prototype_platform_media_items_v1")

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
    val missing = requiredCapabilities - AutoMobilePrototype.capabilitiesForSdk(33) - exclusions
    assertTrue("Renderer is missing spec capabilities: $missing", missing.isEmpty())
  }

  @Test
  fun `production getter delegates to the sdk gated capabilities set`() {
    assertEquals(
      AutoMobilePrototype.capabilitiesForSdk(android.os.Build.VERSION.SDK_INT),
      AutoMobilePrototype.capabilities,
    )
    assertTrue("prototype_custom_shaders_v1" !in AutoMobilePrototype.capabilitiesForSdk(32))
    assertTrue("prototype_custom_shaders_v1" in AutoMobilePrototype.capabilitiesForSdk(33))
  }

  @Test
  fun `capabilities are sorted`() {
    val capabilities = AutoMobilePrototype.capabilities.toList()
    assertEquals(capabilities.sorted(), capabilities)
  }
}
