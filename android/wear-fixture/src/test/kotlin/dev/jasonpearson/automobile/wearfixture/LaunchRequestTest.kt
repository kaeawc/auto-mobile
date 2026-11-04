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
  }
}
