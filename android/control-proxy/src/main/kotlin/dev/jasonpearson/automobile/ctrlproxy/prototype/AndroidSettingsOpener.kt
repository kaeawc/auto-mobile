package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.net.toUri

// Android `settings.open` (#14320). The plan is pure and tested with a fake gateway; the system
// gateway is the only code that touches PackageManager or starts an activity. Nothing here writes
// a setting: every page only opens Settings for the user to change.

/**
 * One page's intent. [packageData] puts `package:<own>` in the data URI and [appPackageExtra] sets
 * `EXTRA_APP_PACKAGE`; [fallback] means the exact page needs a newer API level than [sdkInt].
 */
internal data class SettingsPlan(
  val action: String,
  val packageData: Boolean = false,
  val appPackageExtra: Boolean = false,
  val fallback: Boolean = false,
)

/**
 * Below API 26 there is no per-app notification page, so `notifications` opens the app's details
 * page, which hosts its notification toggle on those versions. Below API 29 there is no Wi-Fi
 * panel, so `wifi` opens the full Wi-Fi settings screen.
 */
internal fun settingsPlan(page: SettingsPage, sdkInt: Int): SettingsPlan =
  when (page) {
    SettingsPage.APP ->
      SettingsPlan(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageData = true)
    SettingsPage.NOTIFICATIONS ->
      if (sdkInt >= Build.VERSION_CODES.O) {
        SettingsPlan(Settings.ACTION_APP_NOTIFICATION_SETTINGS, appPackageExtra = true)
      } else {
        SettingsPlan(
          Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          packageData = true,
          fallback = true,
        )
      }
    SettingsPage.LOCATION -> SettingsPlan(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
    SettingsPage.WIFI ->
      if (sdkInt >= Build.VERSION_CODES.Q) SettingsPlan(Settings.Panel.ACTION_WIFI)
      else SettingsPlan(Settings.ACTION_WIFI_SETTINGS, fallback = true)
    SettingsPage.BLUETOOTH -> SettingsPlan(Settings.ACTION_BLUETOOTH_SETTINGS)
    SettingsPage.DISPLAY -> SettingsPlan(Settings.ACTION_DISPLAY_SETTINGS)
  }

/** The overlay is not an activity, so every intent starts a new task. */
internal fun settingsIntent(plan: SettingsPlan, ownPackage: String): Intent =
  Intent(plan.action).apply {
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (plan.packageData) data = "package:$ownPackage".toUri()
    if (plan.appPackageExtra) putExtra(Settings.EXTRA_APP_PACKAGE, ownPackage)
  }

/** The framework calls [AndroidSettingsOpener] makes, behind a seam so tests need no device. */
internal interface SettingsGateway {
  /** The runtime's own package; the only package a page is ever opened for. */
  fun ownPackage(): String

  fun sdkInt(): Int

  /** The package that would handle the intent, or null when none does. */
  fun handler(intent: Intent): String?

  /** Starts the activity; throws [ActivityNotFoundException] when nothing handles it. */
  fun start(intent: Intent)
}

internal class AndroidSettingsOpener(private val gateway: SettingsGateway) : SettingsOpener {
  override fun open(page: SettingsPage): SettingsOpenResult {
    val plan = settingsPlan(page, gateway.sdkInt())
    val intent = settingsIntent(plan, gateway.ownPackage())
    val handler = gateway.handler(intent) ?: return SettingsOpenResult.Unavailable
    return try {
      gateway.start(intent)
      SettingsOpenResult.Opened(plan.fallback, handler)
    } catch (error: ActivityNotFoundException) {
      // The handler went away between resolving and starting: report it like no handler at all.
      Log.w(TAG, "No activity opened the ${page.wireValue} settings page", error)
      SettingsOpenResult.Unavailable
    }
  }

  private companion object {
    const val TAG = "PrototypeSettings"
  }
}

internal class SystemSettingsGateway(private val context: Context) : SettingsGateway {
  // The overlay registers modules before its context is attached; resolve both on use.
  private val packages: PackageManager by lazy { context.packageManager }

  override fun ownPackage(): String = context.packageName

  override fun sdkInt(): Int = Build.VERSION.SDK_INT

  override fun handler(intent: Intent): String? =
    packages.resolveActivity(intent, 0)?.activityInfo?.packageName

  override fun start(intent: Intent) = context.startActivity(intent)
}
