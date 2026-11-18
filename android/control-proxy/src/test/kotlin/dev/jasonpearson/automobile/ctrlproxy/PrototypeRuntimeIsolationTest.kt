package dev.jasonpearson.automobile.ctrlproxy

import android.content.ContextWrapper
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeRuntimePlatform
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Contract and manifest checks use only the JVM; no server or Android runtime is started. */
class PrototypeRuntimeIsolationTest {
  private val scope = TestScope()
  // Sources acquire Android services lazily, so registration needs no real context.
  private val overlay = prototypeRuntimePlatform(ContextWrapper(null))
  private val registered = overlay.registry.modules.map { it.name }.toSet()

  @After
  fun tearDown() {
    scope.cancel()
  }

  @Test
  fun `registered permissioned modules equal the explicit allow list`() {
    assertTrue("No permissioned calls found in the contract", permissionedModules.isNotEmpty())
    // test.protected exercises declaration checks but accesses no permissioned Android API.
    assertTrue(modules.getValue("test").jsonObject.getValue("placeholder").jsonPrimitive.boolean)
    assertEquals(setOf("camera"), callPermissions(modules.getValue("test").jsonObject))
    assertEquals(EXPECTED_PERMISSIONED_MODULES + "test", permissionedModules intersect registered)
    assertEquals(
      EXPECTED_PERMISSIONED_MODULES,
      (permissionedModules - "test") intersect registered,
    )
  }

  @Test
  fun `allow listed modules declare every mapped Android permission in the manifest`() {
    val file = File("src/main/AndroidManifest.xml")
    assertTrue("Expected module manifest at ${file.absolutePath}", file.isFile)
    val factory = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
    val permissions =
      factory.newDocumentBuilder().parse(file).getElementsByTagName("uses-permission")
    val declared =
      (0 until permissions.length)
        .map {
          permissions.item(it).attributes.getNamedItemNS(ANDROID_NAMESPACE, "name").nodeValue
        }
        .toSet()
    EXPECTED_PERMISSIONED_MODULES.forEach { name ->
      val needed = callPermissions(modules.getValue(name).jsonObject)
      assertTrue("$name has no contract permissions", needed.isNotEmpty())
      needed.forEach { permission ->
        val manifest =
          permissionMapping
            .getValue(permission)
            .jsonObject
            .getValue("android")
            .jsonObject
            .getValue("manifest")
            .jsonArray
            .map { it.jsonPrimitive.content }
        manifest.forEach {
          assertTrue(
            "$name needs $permission mapped to $it in CtrlProxy's manifest",
            it in declared,
          )
        }
      }
    }
  }

  @Test
  fun `blocked modules and their per call capabilities are neither registered nor advertised`() {
    val commands =
      WebSocketServer(
          port = 0,
          scope = scope,
          options = WebSocketServerOptions(sdkInt = { 36 }),
          platform = overlay,
        )
        .supportedCommands()
        .toSet()
    val blocked =
      (permissionedModules - EXPECTED_PERMISSIONED_MODULES - "test") +
        setOf("permissions", "contacts", "calendar", "secureStorage", "biometric")
    assertTrue(
      blocked.containsAll(setOf("camera", "mediaLibrary", "audioRecorder", "notifications")),
    )
    blocked.forEach { name ->
      val module = modules.getValue(name).jsonObject
      assertFalse("$name is registered", name in registered)
      val capabilities =
        listOf(module.getValue("capability").jsonPrimitive.content) +
          module.getValue("calls").jsonObject.values.mapNotNull {
            it.jsonObject["capability"]?.jsonPrimitive?.content
          }
      capabilities.forEach { capability ->
        assertFalse(
          "$name registry advertises $capability",
          capability in overlay.registry.capabilities,
        )
        assertFalse("$name server advertises $capability", capability in commands)
      }
    }
    EXPECTED_PERMISSIONED_MODULES.forEach { name ->
      assertTrue(
        modules.getValue(name).jsonObject.getValue("capability").jsonPrimitive.content in commands,
      )
    }
  }

  companion object {
    private const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    private val EXPECTED_PERMISSIONED_MODULES = setOf("location")
    private val modules =
      resource("/prototype-spec-contract.json").getValue("platformModules").jsonObject
    // Both canonical JSON files are already packaged by :protocol as classpath resources.
    private val permissionMapping = resource("/prototype-platform-permissions.json")
    private val permissionedModules =
      modules.filterValues { callPermissions(it.jsonObject).isNotEmpty() }.keys

    private fun callPermissions(module: JsonObject): Set<String> =
      module
        .getValue("calls")
        .jsonObject
        .values
        .flatMap {
          it.jsonObject.getValue("permissions").jsonArray.map { permission ->
            permission.jsonPrimitive.content
          }
        }
        .toSet()

    private fun resource(path: String): JsonObject =
      Json.parseToJsonElement(
          checkNotNull(PrototypeRuntimeIsolationTest::class.java.getResourceAsStream(path)) {
              "Missing test resource $path"
            }
            .bufferedReader()
            .use { it.readText() },
        )
        .jsonObject
  }
}
