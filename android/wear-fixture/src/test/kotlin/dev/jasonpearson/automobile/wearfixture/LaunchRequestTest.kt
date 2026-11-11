package dev.jasonpearson.automobile.wearfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LaunchRequestTest {
  @Test
  fun `an item id opens that item's detail screen above home`() {
    val stack = LaunchRequest(itemId = "item_07").backStack()
    assertEquals(listOf("home", "detail/item_07"), stack?.toRoutes())
  }

  @Test
  fun `an unknown item id keeps the current screen`() {
    assertNull(LaunchRequest(itemId = "item_99").backStack())
    assertNull(LaunchRequest().backStack())
  }

  @Test
  fun `a notification action sets the status line`() {
    assertEquals(
      "Notification action: Archive",
      LaunchRequest(notificationActionId = "archive").status(),
    )
    assertNull(LaunchRequest().status())
    assertEquals(
      "Notification action: Reply",
      LaunchRequest(notificationActionId = "reply").status(),
    )
    assertNull(LaunchRequest(notificationActionId = "snooze").status())
  }

  @Test
  fun `reply text takes precedence over the notification action status`() {
    assertEquals(
      "Notification reply: On my way",
      LaunchRequest(notificationActionId = "reply", replyText = "On my way").status(),
    )
    assertEquals("Notification reply: Hello", LaunchRequest(replyText = "Hello").status())
  }

  @Test
  fun `a non-null reply is preserved even when empty or surrounded by whitespace`() {
    assertEquals(
      "Notification reply: ",
      LaunchRequest(notificationActionId = "reply", replyText = "").status(),
    )
    assertEquals(
      "Notification reply:  Thanks! ",
      LaunchRequest(replyText = " Thanks! ").status(),
    )
  }
}
