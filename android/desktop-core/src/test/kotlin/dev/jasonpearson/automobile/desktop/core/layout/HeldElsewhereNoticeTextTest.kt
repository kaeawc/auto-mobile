package dev.jasonpearson.automobile.desktop.core.layout

import dev.jasonpearson.automobile.desktop.core.daemon.HeldElsewhereHolder
import kotlin.test.Test
import kotlin.test.assertEquals

class HeldElsewhereNoticeTextTest {
  @Test
  fun `another session keeps the existing wording`() {
    val expected = "Viewing only: another session controls this device"
    assertEquals(expected, heldElsewhereNoticeText(HeldElsewhereHolder.AnotherSession))
    assertEquals(expected, heldElsewhereNoticeText(null))
  }

  @Test
  fun `another daemon is named with its PID when known (#11365)`() {
    assertEquals(
      "Viewing only: held elsewhere by another AutoMobile daemon (PID 4242)",
      heldElsewhereNoticeText(HeldElsewhereHolder.AnotherDaemon(pid = 4242)),
    )
    assertEquals(
      "Viewing only: held elsewhere by another AutoMobile daemon",
      heldElsewhereNoticeText(HeldElsewhereHolder.AnotherDaemon(pid = null)),
    )
  }

  @Test
  fun `a declared binding is named by its index when known (#11365)`() {
    assertEquals(
      "Viewing only: held elsewhere, reserved for binding 0",
      heldElsewhereNoticeText(HeldElsewhereHolder.Binding(declaredBinding = 0)),
    )
    assertEquals(
      "Viewing only: held elsewhere, reserved for a binding",
      heldElsewhereNoticeText(HeldElsewhereHolder.Binding(declaredBinding = null)),
    )
  }
}
