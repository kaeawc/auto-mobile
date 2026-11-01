package dev.jasonpearson.automobile.ctrlproxy

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class SystemAppFlagTest {
  private val packageManager: PackageManager =
    ApplicationProvider.getApplicationContext<Context>().packageManager
  private val failures = mutableListOf<Exception>()

  private fun install(packageName: String, flags: Int) {
    shadowOf(packageManager)
      .installPackage(
        PackageInfo().apply {
          this.packageName = packageName
          applicationInfo =
            ApplicationInfo().apply {
              this.packageName = packageName
              this.flags = flags
            }
        },
      )
  }

  private fun flagOf(packageName: String) =
    packageManager.systemAppFlag(packageName) { failures += it }

  @Test
  fun `a preinstalled or updated system package is a system app`() {
    install("com.android.settings", ApplicationInfo.FLAG_SYSTEM)
    install("com.google.android.gms", ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)

    assertEquals(true, flagOf("com.android.settings"))
    assertEquals(true, flagOf("com.google.android.gms"))
    assertTrue(failures.isEmpty())
  }

  @Test
  fun `a user-installed package is not, whatever its other flags`() {
    install("com.example.app", ApplicationInfo.FLAG_DEBUGGABLE or ApplicationInfo.FLAG_HAS_CODE)

    assertEquals(false, flagOf("com.example.app"))
  }

  @Test
  fun `an unknown package is unresolved and reported, not guessed`() {
    assertNull(flagOf("com.example.missing"))
    assertEquals(1, failures.size)
  }
}
