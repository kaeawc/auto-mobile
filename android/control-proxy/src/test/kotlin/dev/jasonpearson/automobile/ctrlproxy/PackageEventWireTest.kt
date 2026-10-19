package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** Wire contract for `package_event` (#10067): `userId` is the Android user, not the app uid. */
class PackageEventWireTest {
  private fun packageEvent(
    action: String,
    packageName: String,
    userId: Int,
    uid: Int?,
    isSystem: Boolean?,
    removedForAllUsers: Boolean,
  ): JsonObject {
    val frame =
      Json.parseToJsonElement(
          packageEventFrame(1L, action, packageName, userId, uid, isSystem, removedForAllUsers),
        )
        .jsonObject
    assertEquals("package_event", frame.getValue("type").jsonPrimitive.content)
    return frame.getValue("event").jsonObject
  }

  @Test
  fun `a primary-user app uid maps to user 0`() {
    assertEquals(0, packageEventUserId(10234))
  }

  @Test
  fun `a work-profile app uid maps to its user id`() {
    assertEquals(10, packageEventUserId(1010234))
  }

  @Test
  fun `a system uid and an absent extra map to the primary user`() {
    assertEquals(0, packageEventUserId(1000))
    assertEquals(0, packageEventUserId(-1))
  }

  @Test
  fun `the event carries the user id and the raw uid`() {
    val event = packageEvent("added", "com.example.app", 10, 1010234, false, false)

    assertEquals(10, event.getValue("userId").jsonPrimitive.int)
    assertEquals(1010234, event.getValue("uid").jsonPrimitive.int)
    assertEquals("added", event.getValue("action").jsonPrimitive.content)
    assertFalse(event.containsKey("removedForAllUsers"))
  }

  @Test
  fun `the uid marker is omitted when the intent had no uid`() {
    val event = packageEvent("removed", "com.example.app", 0, null, null, true)

    assertNull(event["uid"])
    assertNull(event["isSystem"])
    assertEquals(0, event.getValue("userId").jsonPrimitive.int)
    assertEquals("true", event.getValue("removedForAllUsers").jsonPrimitive.content)
  }
}
