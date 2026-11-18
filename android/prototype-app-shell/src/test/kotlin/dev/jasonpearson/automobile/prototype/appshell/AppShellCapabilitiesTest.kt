package dev.jasonpearson.automobile.prototype.appshell

import androidx.activity.ComponentActivity
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AppShellCapabilitiesTest {
  private val platform =
    appShellPlatform(Robolectric.buildActivity(ComponentActivity::class.java).setup().get())

  @After
  fun closeModules() {
    platform.registry.modules.forEach { it.close() }
  }

  @Test
  fun `the packaged template advertises exactly what the shell's renderer and modules provide`() {
    assertEquals(appShellTemplateCapabilities(platform).toList(), packagedCapabilities())
  }

  @Test
  fun `the template advertises the core platform, storage and every registered module`() {
    val advertised = appShellTemplateCapabilities(platform)
    assertTrue("prototype_platform_v1" in advertised)
    assertTrue("prototype_storage_v1" in advertised)
    assertTrue(advertised.containsAll(platform.registry.capabilities))
    assertTrue("prototype_platform_location_v1" in advertised)
  }

  @Test
  fun `the template never promises an SDK-gated or unregistered capability`() {
    val advertised = appShellTemplateCapabilities(platform)
    assertFalse("prototype_custom_shaders_v1" in advertised)
    assertFalse("prototype_platform_notifications_v1" in advertised)
    assertFalse("prototype_platform_test_v1" in advertised)
  }

  private fun packagedCapabilities(): List<String> {
    val file =
      generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .map { File(it, "android/prototype-app-shell/src/base/assets/capabilities.json") }
        .first { it.isFile }
    val root = Json.parseToJsonElement(file.readText()).jsonObject
    assertEquals("base", root.getValue("template").jsonPrimitive.content)
    return root.getValue("capabilities").jsonArray.map { it.jsonPrimitive.content }
  }
}
