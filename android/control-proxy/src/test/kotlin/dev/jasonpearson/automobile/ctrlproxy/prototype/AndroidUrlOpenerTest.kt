package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ActivityNotFoundException
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidUrlOpenerTest {
  /** Models PackageManager resolution: handlers by intent action and scheme, plus Custom Tabs. */
  private class FakeGateway(
    var customTabs: Boolean = true,
    val handlers: MutableMap<Pair<String, String>, String> = mutableMapOf(),
    var vanishOnStart: Boolean = false,
  ) : LinkGateway {
    val started = mutableListOf<Intent>()

    override fun customTabsAvailable() = customTabs

    override fun handler(intent: Intent): String? =
      handlers[intent.action.orEmpty() to intent.data?.scheme.orEmpty()]

    override fun start(intent: Intent) {
      if (vanishOnStart) throw ActivityNotFoundException("gone")
      started += intent
    }
  }

  private fun browserGateway(customTabs: Boolean = true) =
    FakeGateway(
      customTabs,
      mutableMapOf(
        (Intent.ACTION_VIEW to "https") to "com.android.chrome",
        (Intent.ACTION_VIEW to "http") to "com.android.chrome",
        (Intent.ACTION_DIAL to "tel") to "com.google.android.dialer",
        (Intent.ACTION_SENDTO to "mailto") to "com.google.android.gm",
        (Intent.ACTION_SENDTO to "sms") to "com.google.android.apps.messaging",
        (Intent.ACTION_VIEW to "geo") to "com.google.android.apps.maps",
      ),
    )

  @Test
  fun `each scheme maps to its intent action and never to ACTION_CALL`() {
    val cases =
      listOf(
        "tel:+15551234567" to Intent.ACTION_DIAL,
        "mailto:ada@example.test" to Intent.ACTION_SENDTO,
        "sms:+15551234567" to Intent.ACTION_SENDTO,
        "geo:37.78,-122.41" to Intent.ACTION_VIEW,
        "https://example.com" to Intent.ACTION_VIEW,
      )
    for ((url, action) in cases) {
      val gateway = browserGateway()
      AndroidUrlOpener(gateway).open(url, LinkMode.EXTERNAL)
      val intent = gateway.started.single()
      assertEquals(url, action, intent.action)
      assertEquals(url, intent.data.toString())
      assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
      assertFalse(intent.hasExtra(CustomTabs.EXTRA_SESSION))
    }
  }

  @Test
  fun `inApp opens a Custom Tab when a provider exists`() {
    val gateway = browserGateway()
    val result = AndroidUrlOpener(gateway).open("https://example.com/terms", LinkMode.IN_APP)
    assertEquals(LinkOpenResult.Opened(LinkMode.IN_APP, false, "com.android.chrome"), result)
    assertTrue(gateway.started.single().hasExtra(CustomTabs.EXTRA_SESSION))
  }

  @Test
  fun `inApp without a Custom Tabs provider falls back to external and says so`() {
    val gateway = browserGateway(customTabs = false)
    val result = AndroidUrlOpener(gateway).open("https://example.com", LinkMode.IN_APP)
    assertEquals(LinkOpenResult.Opened(LinkMode.EXTERNAL, true, "com.android.chrome"), result)
    assertFalse(gateway.started.single().hasExtra(CustomTabs.EXTRA_SESSION))
  }

  @Test
  fun `auto picks a Custom Tab when it can and external silently otherwise`() {
    assertEquals(
      LinkOpenResult.Opened(LinkMode.IN_APP, false, "com.android.chrome"),
      AndroidUrlOpener(browserGateway()).open("https://example.com", LinkMode.AUTO),
    )
    assertEquals(
      LinkOpenResult.Opened(LinkMode.EXTERNAL, false, "com.android.chrome"),
      AndroidUrlOpener(browserGateway(customTabs = false)).open("http://a.test", LinkMode.AUTO),
    )
  }

  @Test
  fun `non-web schemes always open externally`() {
    val gateway = browserGateway()
    val result = AndroidUrlOpener(gateway).open("tel:+1555", LinkMode.AUTO)
    assertEquals(
      LinkOpenResult.Opened(LinkMode.EXTERNAL, false, "com.google.android.dialer"),
      result,
    )
    assertFalse(gateway.started.single().hasExtra(CustomTabs.EXTRA_SESSION))
  }

  @Test
  fun `no handler is unavailable and starts nothing`() {
    val gateway = FakeGateway()
    assertEquals(
      LinkOpenResult.Unavailable,
      AndroidUrlOpener(gateway).open("maps://?q=a", LinkMode.AUTO),
    )
    assertTrue(gateway.started.isEmpty())
  }

  @Test
  fun `a handler that vanishes before start is unavailable`() {
    val gateway = browserGateway().apply { vanishOnStart = true }
    assertEquals(
      LinkOpenResult.Unavailable,
      AndroidUrlOpener(gateway).open("geo:1,2", LinkMode.EXTERNAL),
    )
  }
}
