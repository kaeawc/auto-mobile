package dev.jasonpearson.automobile.ctrlproxy

import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/**
 * `listApps` reports the same `launchable` whether the answer came from CtrlProxy or from the adb
 * `cmd package query-activities` fallback, so both must use the SAME launcher criterion.
 * `getLaunchIntentForPackage` is NOT that criterion: it accepts `CATEGORY_INFO` before it looks at
 * `CATEGORY_LAUNCHER`, so a package with only a MAIN/INFO activity would read as launchable over
 * CtrlProxy and unlaunchable over adb for the same install (#6924 review).
 */
@RunWith(RobolectricTestRunner::class)
class InstalledPackageLaunchabilityTest {

  private fun installActivity(packageName: String, category: String) {
    val component = ComponentName(packageName, "$packageName.EntryActivity")
    val shadow = shadowOf(RuntimeEnvironment.getApplication().packageManager)
    shadow.addActivityIfNotPresent(component)
    shadow.addIntentFilterForActivity(
      component,
      IntentFilter(Intent.ACTION_MAIN).apply { addCategory(category) },
    )
  }

  @Test
  fun `reports a package with a MAIN LAUNCHER activity as launchable`() {
    installActivity("com.example.launcherapp", Intent.CATEGORY_LAUNCHER)

    val launchable = launchablePackageNames(RuntimeEnvironment.getApplication().packageManager)

    assertTrue(launchable?.contains("com.example.launcherapp") == true)
  }

  @Test
  fun `does not report a MAIN INFO only package as launchable`() {
    installActivity("com.example.infoonly", Intent.CATEGORY_INFO)

    val launchable = launchablePackageNames(RuntimeEnvironment.getApplication().packageManager)

    assertFalse(launchable?.contains("com.example.infoonly") == true)
  }

  @Test
  fun `returns unknown when the batched launcher query fails`() {
    val launchable =
      launchablePackageNames(RuntimeEnvironment.getApplication().packageManager) {
        throw android.os.TransactionTooLargeException("large launcher response")
      }

    assertNull(launchable)
  }

  @Test
  fun `unknown launchability produces null protocol records`() {
    val launchablePackages =
      launchablePackageNames(RuntimeEnvironment.getApplication().packageManager) {
        throw android.os.TransactionTooLargeException("large launcher response")
      }
    val records =
      listOf("com.example.first", "com.example.second").map { packageName ->
        dev.jasonpearson.automobile.protocol.InstalledPackageRecord(
          packageName = packageName,
          isSystem = false,
          launchable = launchablePackages?.contains(packageName),
        )
      }

    assertTrue(records.all { it.launchable == null })
  }
}
