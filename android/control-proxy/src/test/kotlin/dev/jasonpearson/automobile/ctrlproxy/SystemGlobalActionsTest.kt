package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemGlobalActionsTest {
  @Test
  fun `maps every wire name to its accessibility global action`() {
    val sdk = 34
    assertEquals(AccessibilityService.GLOBAL_ACTION_BACK, SystemGlobalActions.resolve("back", sdk))
    assertEquals(AccessibilityService.GLOBAL_ACTION_HOME, SystemGlobalActions.resolve("home", sdk))
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_RECENTS,
      SystemGlobalActions.resolve("recent", sdk),
    )
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_RECENTS,
      SystemGlobalActions.resolve("recents", sdk),
    )
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS,
      SystemGlobalActions.resolve("notifications", sdk),
    )
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_POWER_DIALOG,
      SystemGlobalActions.resolve("power_dialog", sdk),
    )
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS,
      SystemGlobalActions.resolve("quick_settings", sdk),
    )
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN,
      SystemGlobalActions.resolve("split_screen", sdk),
    )
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN,
      SystemGlobalActions.resolve("lock_screen", sdk),
    )
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT,
      SystemGlobalActions.resolve("screenshot", sdk),
    )
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE,
      SystemGlobalActions.resolve("dismiss_notification_shade", sdk),
    )
  }

  @Test
  fun `wire names are case-insensitive`() {
    assertEquals(
      AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN,
      SystemGlobalActions.resolve("LOCK_SCREEN", 34),
    )
  }

  @Test
  fun `unknown action resolves to null with an unsupported refusal`() {
    assertNull(SystemGlobalActions.resolve("reboot", 34))
    assertEquals("Unsupported global action: reboot", SystemGlobalActions.refusal("reboot", 34))
  }

  @Test
  fun `lock_screen and screenshot need API 28`() {
    for (action in listOf("lock_screen", "screenshot")) {
      assertNull("$action on API 27", SystemGlobalActions.resolve(action, 27))
      assertEquals(
        "Global action $action requires Android API 28+ (device is API 27)",
        SystemGlobalActions.refusal(action, 27),
      )
      assertTrue("$action on API 28", SystemGlobalActions.resolve(action, 28) != null)
      assertNull(SystemGlobalActions.refusal(action, 28))
    }
  }

  @Test
  fun `dismiss_notification_shade needs API 31`() {
    assertNull(SystemGlobalActions.resolve("dismiss_notification_shade", 30))
    assertEquals(
      "Global action dismiss_notification_shade requires Android API 31+ (device is API 30)",
      SystemGlobalActions.refusal("dismiss_notification_shade", 30),
    )
    assertTrue(SystemGlobalActions.resolve("dismiss_notification_shade", 31) != null)
  }

  @Test
  fun `advertised flags follow the device API level`() {
    val api27 = SystemGlobalActions.advertisedFlags(27)
    assertTrue(api27.contains("global_action_power_dialog_v1"))
    assertTrue(api27.contains("global_action_quick_settings_v1"))
    assertTrue(api27.contains("global_action_split_screen_v1"))
    assertFalse(api27.contains("global_action_lock_screen_v1"))
    assertFalse(api27.contains("global_action_screenshot_v1"))
    assertFalse(api27.contains("global_action_dismiss_notification_shade_v1"))

    val api30 = SystemGlobalActions.advertisedFlags(30)
    assertTrue(api30.contains("global_action_lock_screen_v1"))
    assertTrue(api30.contains("global_action_screenshot_v1"))
    assertFalse(api30.contains("global_action_dismiss_notification_shade_v1"))

    val api34 = SystemGlobalActions.advertisedFlags(34)
    assertEquals(
      listOf(
        "global_action_power_dialog_v1",
        "global_action_quick_settings_v1",
        "global_action_split_screen_v1",
        "global_action_lock_screen_v1",
        "global_action_screenshot_v1",
        "global_action_dismiss_notification_shade_v1",
      ),
      api34,
    )
  }

  @Test
  fun `long-standing actions carry no capability flag`() {
    val flagless = SystemGlobalActions.specs.filter { it.capabilityFlag == null }.map { it.wireName }
    assertEquals(listOf("back", "home", "recent", "notifications"), flagless)
  }
}
