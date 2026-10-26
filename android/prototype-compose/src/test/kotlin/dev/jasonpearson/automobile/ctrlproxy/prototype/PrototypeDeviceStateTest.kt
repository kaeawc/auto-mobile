package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeDeviceStateTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeDeviceContract.breakpoints("widthClass")
    }
  }

  private fun input(
    width: Float = 400f,
    height: Float = 800f,
    smallest: Int = 400,
    fold: PrototypeFold = PrototypeFold.NONE,
    pc: Boolean = false,
  ) = PrototypeDeviceInput(width, height, smallest, fold, false, "16", pc)

  @Test
  fun `device observation is not user activity`() {
    assertFalse(
      PrototypeInteraction.DeviceState(PrototypeDeviceState.snapshot(input()))
        .countsAsUserActivity(emptyMap()),
    )
    assertTrue(PrototypeInteraction.Tap(emptyList()).countsAsUserActivity(emptyMap()))
    assertFalse(
      PrototypeInteraction.PagerMotion("pager", 0, false).countsAsUserActivity(mapOf("pager" to 0)),
    )
    assertTrue(
      PrototypeInteraction.PagerMotion("pager", 1, false).countsAsUserActivity(mapOf("pager" to 0)),
    )
  }

  @Test
  fun `material boundaries use reported dp`() {
    for ((value, expected) in
      listOf(599 to "compact", 600 to "medium", 839 to "medium", 840 to "expanded")) {
      assertEquals(
        expected,
        PrototypeDeviceState.snapshot(input(width = value.toFloat()))
          .getValue("device")
          .jsonObject
          .getValue("widthClass")
          .jsonPrimitive
          .content,
      )
    }
    for ((value, expected) in
      listOf(479 to "compact", 480 to "medium", 899 to "medium", 900 to "expanded")) {
      assertEquals(
        expected,
        PrototypeDeviceState.snapshot(input(height = value.toFloat()))
          .getValue("device")
          .jsonObject
          .getValue("heightClass")
          .jsonPrimitive
          .content,
      )
    }
  }

  @Test
  fun `fractional sizes classify the reported rounded integers`() {
    for ((width, height, expected) in
      listOf(
        Triple(599.6f, 479.6f, "medium"),
        Triple(839.6f, 899.6f, "expanded"),
        Triple(599.4f, 479.4f, "compact"),
      )) {
      val device = PrototypeDeviceState.snapshot(input(width, height)).getValue("device").jsonObject
      assertEquals(expected, device.getValue("widthClass").jsonPrimitive.content)
      assertEquals(expected, device.getValue("heightClass").jsonPrimitive.content)
      assertEquals(
        kotlin.math.round(width).toInt(),
        device.getValue("windowWidth").jsonPrimitive.int,
      )
      assertEquals(
        kotlin.math.round(height).toInt(),
        device.getValue("windowHeight").jsonPrimitive.int,
      )
    }
  }

  @Test
  fun `posture idiom and platform specific keys`() {
    for ((fold, posture) in
      listOf(
        PrototypeFold.NONE to null,
        PrototypeFold.FLAT to "flat",
        PrototypeFold.HALF_OPENED_HORIZONTAL to "tabletop",
        PrototypeFold.HALF_OPENED_VERTICAL to "book",
      )) {
      val device = PrototypeDeviceState.snapshot(input(fold = fold)).getValue("device").jsonObject
      assertEquals(posture, device["posture"]?.jsonPrimitive?.content)
      assertEquals(
        if (fold == PrototypeFold.NONE) "phone" else "foldable",
        device.getValue("idiom").jsonPrimitive.content,
      )
      assertFalse("sizeClass" in device)
    }
    assertEquals(
      "desktop",
      PrototypeDeviceState.snapshot(input(smallest = 600, pc = true))
        .getValue("device")
        .jsonObject
        .getValue("idiom")
        .jsonPrimitive
        .content,
    )
    assertEquals(
      "desktop",
      PrototypeDeviceState.snapshot(input(pc = true))
        .getValue("device")
        .jsonObject
        .getValue("idiom")
        .jsonPrimitive
        .content,
    )
    assertEquals(
      "tablet",
      PrototypeDeviceState.snapshot(input(smallest = 600))["device"]!!
        .jsonObject["idiom"]!!
        .jsonPrimitive
        .content,
    )
    assertEquals(
      "foldable",
      PrototypeDeviceState.snapshot(input(smallest = 600, pc = true, fold = PrototypeFold.FLAT))[
          "device"]!!
        .jsonObject["idiom"]!!
        .jsonPrimitive
        .content,
    )
    val device =
      PrototypeDeviceState.snapshot(input(width = 401.6f, height = 700.2f).copy(hasPointer = true))
        .getValue("device")
        .jsonObject
    assertEquals(JsonPrimitive(402), device["windowWidth"])
    assertEquals(JsonPrimitive(700), device["windowHeight"])
    assertEquals(JsonPrimitive(true), device["pointer"])
    assertEquals(JsonPrimitive("android"), device["os"])
    assertEquals(JsonPrimitive("16"), device["osVersion"])
  }
}
