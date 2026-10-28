package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemLinkGatewayTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val packages = shadowOf(context.packageManager)

  private fun customTabsService(pkg: String) {
    val component = ComponentName(pkg, "$pkg.CustomTabsService")
    packages.addOrUpdateService(
      android.content.pm.ServiceInfo().apply {
        packageName = pkg
        name = component.className
        applicationInfo = android.content.pm.ApplicationInfo().apply { packageName = pkg }
      },
    )
    packages.addIntentFilterForService(
      component,
      IntentFilter(CustomTabs.SERVICE_ACTION),
    )
  }

  private fun defaultBrowser(pkg: String) {
    val component = ComponentName(pkg, "$pkg.Browser")
    packages.addActivityIfNotPresent(component)
    packages.addIntentFilterForActivity(
      component,
      IntentFilter(Intent.ACTION_VIEW).apply {
        addCategory(Intent.CATEGORY_BROWSABLE)
        addCategory(Intent.CATEGORY_DEFAULT)
        addDataScheme("http")
      },
    )
  }

  @Test
  fun `no Custom Tabs service means no package`() {
    assertNull(SystemLinkGateway(context).customTabsPackage())
  }

  @Test
  fun `the default browser is chosen when it provides Custom Tabs`() {
    // The default browser is neither the first registered nor the first by name.
    customTabsService("org.example.alpha")
    customTabsService("org.example.zulu")
    defaultBrowser("org.example.zulu")
    val gateway = SystemLinkGateway(context)
    assertEquals("org.example.zulu", gateway.customTabsPackage())
  }

  @Test
  fun `a default browser without Custom Tabs falls back to the first provider`() {
    customTabsService("org.example.first")
    defaultBrowser("org.example.plain")
    assertEquals("org.example.first", SystemLinkGateway(context).customTabsPackage())
  }
}
