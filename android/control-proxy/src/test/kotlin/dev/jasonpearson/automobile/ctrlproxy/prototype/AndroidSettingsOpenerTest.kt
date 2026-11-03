package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidSettingsOpenerTest {
  /** Models PackageManager resolution: every action resolves unless listed as missing. */
  private class FakeGateway(
    var sdk: Int = 34,
    val missing: MutableSet<String> = mutableSetOf(),
    var vanishOnStart: Boolean = false,
  ) : SettingsGateway {
    val started = mutableListOf<Intent>()

    override fun ownPackage() = OWN

    override fun sdkInt() = sdk

    override fun handler(intent: Intent): String? =
      if (intent.action in missing) null else "com.android.settings"

    override fun start(intent: Intent) {
      if (vanishOnStart) throw ActivityNotFoundException("gone")
      started += intent
    }
  }

  @Test
  fun `each page maps to its settings action for the runtime's own package`() {
    val cases =
      listOf(
        SettingsPage.APP to Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        SettingsPage.NOTIFICATIONS to Settings.ACTION_APP_NOTIFICATION_SETTINGS,
        SettingsPage.LOCATION to Settings.ACTION_LOCATION_SOURCE_SETTINGS,
        SettingsPage.WIFI to Settings.Panel.ACTION_WIFI,
        SettingsPage.BLUETOOTH to Settings.ACTION_BLUETOOTH_SETTINGS,
        SettingsPage.DISPLAY to Settings.ACTION_DISPLAY_SETTINGS,
      )
    for ((page, action) in cases) {
      val gateway = FakeGateway()
      val result = AndroidSettingsOpener(gateway).open(page)
      assertEquals(page.name, SettingsOpenResult.Opened(false, "com.android.settings"), result)
      val intent = gateway.started.single()
      assertEquals(page.name, action, intent.action)
      assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    }
  }

  @Test
  fun `app and notifications target only the own package`() {
    val gateway = FakeGateway()
    AndroidSettingsOpener(gateway).open(SettingsPage.APP)
    AndroidSettingsOpener(gateway).open(SettingsPage.NOTIFICATIONS)
    val (app, notifications) = gateway.started
    assertEquals("package:$OWN", app.data.toString())
    assertFalse(app.hasExtra(Settings.EXTRA_APP_PACKAGE))
    assertEquals(OWN, notifications.getStringExtra(Settings.EXTRA_APP_PACKAGE))
    assertNull(notifications.data)
  }

  @Test
  fun `device-wide pages carry no package`() {
    val gateway = FakeGateway()
    listOf(SettingsPage.LOCATION, SettingsPage.WIFI, SettingsPage.BLUETOOTH, SettingsPage.DISPLAY)
      .forEach { AndroidSettingsOpener(gateway).open(it) }
    for (intent in gateway.started) {
      assertNull(intent.action, intent.data)
      assertFalse(intent.action, intent.hasExtra(Settings.EXTRA_APP_PACKAGE))
    }
  }

  @Test
  fun `older API levels open a broader page and report a fallback`() {
    val gateway = FakeGateway(sdk = 25)
    assertEquals(
      SettingsOpenResult.Opened(true, "com.android.settings"),
      AndroidSettingsOpener(gateway).open(SettingsPage.NOTIFICATIONS),
    )
    assertEquals(
      SettingsOpenResult.Opened(true, "com.android.settings"),
      AndroidSettingsOpener(gateway).open(SettingsPage.WIFI),
    )
    val (notifications, wifi) = gateway.started
    assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, notifications.action)
    assertEquals("package:$OWN", notifications.data.toString())
    assertEquals(Settings.ACTION_WIFI_SETTINGS, wifi.action)
  }

  @Test
  fun `the exact pages start at API 26 for notifications and API 29 for the Wi-Fi panel`() {
    assertFalse(settingsPlan(SettingsPage.NOTIFICATIONS, 26).fallback)
    assertTrue(settingsPlan(SettingsPage.WIFI, 28).fallback)
    assertFalse(settingsPlan(SettingsPage.WIFI, 29).fallback)
  }

  @Test
  fun `no handler is unavailable and nothing starts`() {
    val gateway = FakeGateway(missing = mutableSetOf(Settings.ACTION_DISPLAY_SETTINGS))
    assertEquals(
      SettingsOpenResult.Unavailable,
      AndroidSettingsOpener(gateway).open(SettingsPage.DISPLAY),
    )
    assertTrue(gateway.started.isEmpty())
  }

  @Test
  fun `a handler that vanishes before start is unavailable`() {
    val gateway = FakeGateway(vanishOnStart = true)
    assertEquals(
      SettingsOpenResult.Unavailable,
      AndroidSettingsOpener(gateway).open(SettingsPage.BLUETOOTH),
    )
  }

  private companion object {
    const val OWN = "dev.jasonpearson.automobile.ctrlproxy"
  }
}
