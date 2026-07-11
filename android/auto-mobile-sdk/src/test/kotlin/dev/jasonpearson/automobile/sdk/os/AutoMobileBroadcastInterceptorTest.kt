package dev.jasonpearson.automobile.sdk.os

import android.content.Intent
import android.net.Uri
import android.os.Build
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.TIRAMISU])
class AutoMobileBroadcastInterceptorTest {

  private val plainActions =
    listOf(
      Intent.ACTION_LOCALE_CHANGED,
      Intent.ACTION_TIMEZONE_CHANGED,
      Intent.ACTION_SCREEN_ON,
      Intent.ACTION_SCREEN_OFF,
      Intent.ACTION_USER_PRESENT,
    )

  private val packageActions = listOf(Intent.ACTION_PACKAGE_ADDED, Intent.ACTION_PACKAGE_REMOVED)

  /**
   * All seven monitored actions must be matched by a registered filter. Pre-fix a single filter
   * declared addDataScheme("package"), so the five scheme-less actions failed the IntentFilter data
   * test and were silently dropped (#3597).
   */
  @Test
  fun `all seven monitored actions match a registered filter`() {
    val filters = AutoMobileBroadcastInterceptor.buildFilters()
    val resolver = RuntimeEnvironment.getApplication().contentResolver

    for (action in plainActions) {
      val intent = Intent(action) // scheme-less, as the real system broadcasts are
      assertTrue(
        "scheme-less action $action should match a registered filter",
        filters.any { it.match(resolver, intent, false, "test") >= 0 },
      )
    }

    for (action in packageActions) {
      val intent = Intent(action).apply { data = Uri.parse("package:com.example.app") }
      assertTrue(
        "package action $action should match a registered filter",
        filters.any { it.match(resolver, intent, false, "test") >= 0 },
      )
    }
  }

  /**
   * The plain-action filter must declare no data scheme, or the scheme-less actions won't match.
   */
  @Test
  fun `plain action filter has no data scheme`() {
    val filters = AutoMobileBroadcastInterceptor.buildFilters()
    val plainFilter = filters.first { !it.hasAction(Intent.ACTION_PACKAGE_ADDED) }
    assertTrue("plain filter must not require a data scheme", plainFilter.countDataSchemes() == 0)
  }
}
