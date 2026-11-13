package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test

/** Parity with the TypeScript and Swift readers: all three read the one canonical schema file. */
class PrototypePlatformPermissionsTest {
  private val schemas = File("../../schemas")

  private fun canonical() =
    Json.parseToJsonElement(File(schemas, "prototype-platform-permissions.json").readText())
      .jsonObject

  @Test
  fun `names are the spec contract permission names in contract order`() {
    val expected =
      PrototypeSpecContract.definitions
        .getValue("platformPermission")
        .jsonObject
        .getValue("fields")
        .jsonObject
        .getValue("name")
        .jsonObject
        .getValue("rule")
        .jsonObject
        .getValue("values")
        .jsonArray
        .map { it.jsonPrimitive.content }
    assertEquals(expected, PrototypePlatformPermissions.names)
    assertEquals(canonical().keys.toList(), PrototypePlatformPermissions.names)
  }

  @Test
  fun `every name has the same manifest list, grant, usage key and simctl service as the file`() {
    for ((name, raw) in canonical()) {
      val mapping = assertNotNull(PrototypePlatformPermissions.mappingFor(name), name)
      val android = raw.jsonObject.getValue("android").jsonObject
      val ios = raw.jsonObject.getValue("ios").jsonObject
      assertEquals(
        android.getValue("manifest").jsonArray.map { it.jsonPrimitive.content },
        mapping.android.manifest,
        name,
      )
      assertEquals(android.getValue("grant").jsonPrimitive.content, mapping.android.grant.wire)
      assertEquals(wire(ios.getValue("usageKey")), mapping.ios.usageKey, name)
      assertEquals(wire(ios.getValue("simctlService")), mapping.ios.simctlService, name)
    }
  }

  @Test
  fun `known entries keep their shape`() {
    val notifications = assertNotNull(PrototypePlatformPermissions.mappingFor("notifications"))
    assertEquals(AndroidPermissionGrant.NOTIFICATIONS, notifications.android.grant)
    assertNull(notifications.ios.usageKey)
    assertNull(notifications.ios.simctlService)
    val location = assertNotNull(PrototypePlatformPermissions.mappingFor("location"))
    assertEquals(
      listOf(
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
      ),
      location.android.manifest,
    )
    assertEquals("location", location.ios.simctlService)
    assertNull(PrototypePlatformPermissions.mappingFor("nope"))
  }

  private fun wire(value: kotlinx.serialization.json.JsonElement): String? =
    if (value is JsonNull) null else value.jsonPrimitive.content
}
