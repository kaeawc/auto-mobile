package dev.jasonpearson.automobile.ctrlproxy

import android.content.ContextWrapper
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import dev.jasonpearson.automobile.ctrlproxy.prototype.prototypeRuntimePlatform
import dev.jasonpearson.automobile.prototype.FakePrototypeClipboard
import dev.jasonpearson.automobile.prototype.PrototypePlatform
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
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController

/** Registration only: no service, saved-prototype UI, database, or permission prompt is started. */
@RunWith(RobolectricTestRunner::class)
class PrototypeRuntimeIsolationTest {
  private val scope = TestScope()
  private lateinit var controller: ActivityController<ComponentActivity>
  private lateinit var overlay: PrototypePlatform
  private lateinit var saved: PrototypePlatform

  @Before
  fun setUp() {
    // Match SavedPrototypeActivity's ComponentActivity host without starting its UI or store.
    controller = Robolectric.buildActivity(ComponentActivity::class.java).create()
    overlay = prototypeRuntimePlatform(ContextWrapper(null))
    saved = prototypeRuntimePlatform(controller.get())
  }

  @After
  fun tearDown() {
    overlay.registry.modules.forEach { it.close() }
    saved.registry.modules.forEach { it.close() }
    scope.cancel()
    controller.destroy()
  }

  @Test
  fun `service host registers exactly its variant inventory`() {
    assertEquals(SERVICE_MODULES + debugModules, registered(overlay))
    assertTrue((ACTIVITY_IDENTITY_MODULES + "permissions").intersect(registered(overlay)).isEmpty())
  }

  @Test
  fun `saved Activity host registers exactly its variant inventory`() {
    assertEquals(ACTIVITY_MODULES + debugModules, registered(saved))
  }

  @Test
  fun `service clipboard injection adds only clipboard`() {
    // CtrlProxy supplies a clipboard adapter; the saved Activity uses the default null adapter.
    val platform = prototypeRuntimePlatform(ContextWrapper(null), FakePrototypeClipboard())
    try {
      assertEquals(SERVICE_MODULES + debugModules + "clipboard", registered(platform))
    } finally {
      platform.registry.modules.forEach { it.close() }
    }
  }

  @Test
  fun `service permissioned modules equal its explicit allow list`() {
    assertEquals(
      SERVICE_PERMISSIONED_MODULES + debugPermissionedModules,
      permissionedModules intersect registered(overlay),
    )
  }

  @Test
  fun `saved Activity permissioned modules equal its explicit allow list`() {
    assertEquals(
      ACTIVITY_PERMISSIONED_MODULES + debugPermissionedModules,
      permissionedModules intersect registered(saved),
    )
  }

  @Test
  fun `call block node and prompting permissions name canonical mapping keys`() {
    assertTrue(
      "No permissioned calls found in the contract",
      modules.values.any { callPermissions(it.jsonObject).isNotEmpty() },
    )
    assertTrue(modules.keys.containsAll(BLOCK_NODE_PERMISSIONS.keys + PROMPT_PERMISSIONS.keys))
    modulePermissions.forEach { (name, permissions) ->
      assertTrue(
        "$name names unknown permissions: ${permissions - permissionMapping.keys}",
        permissionMapping.keys.containsAll(permissions),
      )
    }
    // test.protected checks declarations without accessing a permissioned Android API.
    assertTrue(modules.getValue("test").jsonObject.getValue("placeholder").jsonPrimitive.boolean)
    assertEquals(setOf("camera"), callPermissions(modules.getValue("test").jsonObject))
  }

  @Test
  fun `both host allow lists declare every mapped Android permission in the manifest`() {
    val declared = manifestPermissions(File("src/main/AndroidManifest.xml"))
    (SERVICE_PERMISSIONED_MODULES + ACTIVITY_PERMISSIONED_MODULES).forEach { name ->
      val needed = modulePermissions.getValue(name)
      assertTrue("$name has no call block node or prompting permissions", needed.isNotEmpty())
      needed.forEach { permission ->
        permissionMapping
          .getValue(permission)
          .jsonObject
          .getValue("android")
          .jsonObject
          .getValue("manifest")
          .jsonArray
          .forEach {
            val androidPermission = it.jsonPrimitive.content
            assertTrue(
              "$name needs $permission mapped to $androidPermission in CtrlProxy's manifest",
              androidPermission in declared,
            )
          }
      }
    }
  }

  @Test
  fun `Activity biometric identity permission is present in the merged host manifest`() {
    // USE_BIOMETRIC is install-time, outside the runtime-permission contract mapping.
    val activity = controller.get()
    val declared =
      activity.packageManager
        .getPackageInfo(activity.packageName, PackageManager.GET_PERMISSIONS)
        .requestedPermissions
        .orEmpty()
        .toSet()
    assertTrue(
      "Merged CtrlProxy manifest needs USE_BIOMETRIC",
      "android.permission.USE_BIOMETRIC" in declared,
    )
  }

  @Test
  fun `service blocked modules and per call capabilities are not advertised`() {
    assertAdvertisement(overlay, SERVICE_MODULES + debugModules)
  }

  @Test
  fun `saved Activity blocked modules and per call capabilities are not advertised`() {
    assertAdvertisement(saved, ACTIVITY_MODULES + debugModules)
  }

  private fun assertAdvertisement(platform: PrototypePlatform, expected: Set<String>) {
    val commands =
      WebSocketServer(
          port = 0,
          scope = scope,
          options = WebSocketServerOptions(sdkInt = { 36 }),
          platform = platform,
        )
        .supportedCommands()
        .toSet()
    val blocked =
      (permissionedModules +
        ACTIVITY_IDENTITY_MODULES +
        setOf("permissions", "contacts", "calendar")) - expected
    assertTrue(
      blocked.containsAll(setOf("camera", "map", "mediaLibrary", "audioRecorder", "notifications")),
    )
    blocked.forEach { name ->
      assertFalse("$name is registered", name in registered(platform))
      capabilities(modules.getValue(name).jsonObject).forEach { capability ->
        assertFalse(
          "$name registry advertises $capability",
          capability in platform.registry.capabilities,
        )
        assertFalse("$name server advertises $capability", capability in commands)
      }
    }
    expected.forEach { name ->
      assertTrue("$name is missing from the registry", name in registered(platform))
      (capabilities(modules.getValue(name).jsonObject) - EXEMPT_CALL_CAPABILITIES[name].orEmpty())
        .forEach { capability ->
          assertTrue("$name server omits $capability", capability in commands)
        }
    }
  }

  companion object {
    private const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    private val SERVICE_MODULES =
      setOf(
        "haptics",
        "sound",
        "location",
        "sensors",
        "connectivity",
        "battery",
        "power",
        "audio",
        "links",
        "settings",
      )
    private val ACTIVITY_IDENTITY_MODULES = setOf("biometric", "secureStorage")
    private val ACTIVITY_MODULES = SERVICE_MODULES + ACTIVITY_IDENTITY_MODULES + "permissions"
    private val SERVICE_PERMISSIONED_MODULES = setOf("location", "sensors")
    private val ACTIVITY_PERMISSIONED_MODULES = setOf("location", "sensors", "permissions")
    private val debugModules = if (BuildConfig.DEBUG) setOf("test", "media") else emptySet()
    /**
     * Per-call capabilities a registered module deliberately does not advertise, so the host
     * refuses those calls: the debug fake media player has no queue until #14249 adds one.
     */
    private val EXEMPT_CALL_CAPABILITIES =
      mapOf("media" to setOf("prototype_platform_media_queue_v1"))
    /** Of [debugModules], the ones whose calls need permissions: the fake media player has none. */
    private val debugPermissionedModules = if (BuildConfig.DEBUG) setOf("test") else emptySet()

    // These requirements live in Kotlin validators, outside the per-call JSON contract.
    private val BLOCK_NODE_PERMISSIONS =
      mapOf(
        "sensors" to setOf("motion"), // sensors.steps (PrototypeSensorRules)
        "map" to setOf("location"), // map.showUserLocation (PrototypeMap)
        "camera" to setOf("camera"), // cameraPreview node (PrototypeCameraPreview)
      )
    // AndroidPermissionsSource can launch POST_NOTIFICATIONS even though its calls have no
    // contract permission. Review this map when its prompt vocabulary grows.
    private val PROMPT_PERMISSIONS = mapOf("permissions" to setOf("notifications"))
    // Both canonical JSON files are already packaged by :protocol as classpath resources.
    private val modules =
      resource("/prototype-spec-contract.json").getValue("platformModules").jsonObject
    private val permissionMapping = resource("/prototype-platform-permissions.json")
    private val modulePermissions = modules.mapValues { (name, module) ->
      callPermissions(module.jsonObject) +
        BLOCK_NODE_PERMISSIONS[name].orEmpty() +
        PROMPT_PERMISSIONS[name].orEmpty()
    }
    private val permissionedModules = modulePermissions.filterValues { it.isNotEmpty() }.keys

    private fun registered(platform: PrototypePlatform): Set<String> =
      platform.registry.modules.map { it.name }.toSet()

    private fun capabilities(module: JsonObject): List<String> =
      listOf(module.getValue("capability").jsonPrimitive.content) +
        module.getValue("calls").jsonObject.values.mapNotNull {
          it.jsonObject["capability"]?.jsonPrimitive?.content
        }

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

    private fun manifestPermissions(file: File): Set<String> {
      check(file.isFile) { "Expected module manifest at ${file.absolutePath}" }
      val permissions =
        DocumentBuilderFactory.newInstance()
          .apply { isNamespaceAware = true }
          .newDocumentBuilder()
          .parse(file)
          .getElementsByTagName("uses-permission")
      return (0 until permissions.length)
        .map {
          permissions.item(it).attributes.getNamedItemNS(ANDROID_NAMESPACE, "name").nodeValue
        }
        .toSet()
    }

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
