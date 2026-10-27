package dev.jasonpearson.automobile.ctrlproxy

import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.pm.PackageInfoCompat
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.InstalledPackageRecord
import dev.jasonpearson.automobile.protocol.InstalledPackagesResult
import dev.jasonpearson.automobile.protocol.LaunchIntentResult
import dev.jasonpearson.automobile.protocol.PackageInfoResult
import kotlinx.coroutines.CancellationException

/** Installed-package enumeration, package metadata and launcher-activity resolution. */
internal class PackageController(
  private val packageManager: () -> PackageManager,
  private val currentUserId: () -> Int,
  private val timeProvider: TimeProvider,
  private val resultSender: ResultSender,
) {
  companion object {
    private const val TAG = "CtrlProxy"
  }

  /**
   * Enumerate installed packages via PackageManager. Returns over WebSocket so callers can avoid
   * the per-call ADB round-trip cost of `pm list packages`.
   */
  suspend fun performInstalledPackages(
    requestId: String?,
    includeSystem: Boolean,
    userId: Int?,
  ) {
    val startTime = timeProvider.currentTimeMillis()
    val currentUserId = currentUserId()
    if (userId != null && userId != currentUserId) {
      broadcastInstalledPackagesResult(
        InstalledPackagesOutcome(
          requestId = requestId,
          success = false,
          userId = currentUserId,
          packages = emptyList(),
          error =
            "Requested userId=$userId differs from service userId=$currentUserId; ADB fallback required",
          totalTimeMs = timeProvider.currentTimeMillis() - startTime,
        ),
      )
      return
    }

    withPackageFailures(
      onFailure = { e ->
        Log.e(TAG, "performInstalledPackages failed", e)
        broadcastInstalledPackagesResult(
          InstalledPackagesOutcome(
            requestId = requestId,
            success = false,
            userId = currentUserId,
            packages = emptyList(),
            error = "Failed to enumerate packages: ${e.message}",
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
      },
    ) {
      val records = installedPackageRecords(includeSystem)
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastInstalledPackagesResult(
        InstalledPackagesOutcome(
          requestId = requestId,
          success = true,
          userId = currentUserId,
          packages = records,
          error = null,
          totalTimeMs = totalTime,
        ),
      )
    }
  }

  private fun installedPackageRecords(includeSystem: Boolean): List<InstalledPackageRecord> {
    val infos =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager()
          .getInstalledPackages(
            PackageManager.PackageInfoFlags.of(0L),
          )
      } else {
        legacyGetInstalledPackages(packageManager())
      }
    // Launchability comes from ONE batched MAIN/LAUNCHER query rather than a
    // per-package getLaunchIntentForPackage, which would accept MAIN/INFO and
    // disagree with the adb fallback for the same install (#6924 review).
    val launchablePackages = launchablePackageNames(packageManager())
    val records = mutableListOf<InstalledPackageRecord>()
    for (info in infos) {
      val isSystem =
        (info.applicationInfo?.flags ?: 0) and
          (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
      if (!includeSystem && isSystem) continue
      val versionCode = PackageInfoCompat.getLongVersionCode(info)
      // The same batched MAIN/LAUNCHER query that establishes launchability also carries the
      // label shown by launchers. Its helper falls back safely when an app disappears mid-list.
      val label =
        preferredInstalledPackageLabel(
          info.packageName,
          info.applicationInfo,
          launchablePackages,
          packageManager(),
        )
      records.add(
        InstalledPackageRecord(
          packageName = info.packageName,
          isSystem = isSystem,
          versionName = info.versionName,
          versionCode = versionCode,
          label = label,
          launchable = launchablePackages?.packageNames?.contains(info.packageName),
        ),
      )
    }

    return records
  }

  /** Read package metadata via PackageManager. */
  suspend fun performPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) {
    val startTime = timeProvider.currentTimeMillis()
    withPackageFailures(
      onFailure = { e ->
        when (e) {
          is PackageManager.NameNotFoundException -> {
            Log.w(TAG, "Package not found: $packageName", e)
            broadcastPackageInfoResult(
              failedPackageInfo(
                requestId,
                packageName,
                "Package not installed or not visible: $packageName",
                timeProvider.currentTimeMillis() - startTime,
              ),
            )
          }
          else -> {
            Log.e(TAG, "performPackageInfo failed for $packageName", e)
            broadcastPackageInfoResult(
              failedPackageInfo(
                requestId,
                packageName,
                "Failed to read package info: ${e.message}",
                timeProvider.currentTimeMillis() - startTime,
              ),
            )
          }
        }
      },
    ) {
      readPackageInfo(requestId, packageName, includePermissions, startTime)
    }
  }

  private fun grantedPermissions(
    info: PackageInfo,
    requested: List<String>,
    includePermissions: Boolean,
  ): Map<String, Boolean> {
    val flagsArray = info.requestedPermissionsFlags
    val granted = mutableMapOf<String, Boolean>()
    if (includePermissions && flagsArray != null) {
      for (i in requested.indices) {
        val isGranted =
          if (i < flagsArray.size) {
            (flagsArray[i] and PackageInfo.REQUESTED_PERMISSION_GRANTED) != 0
          } else false
        granted[requested[i]] = isGranted
      }
    }
    return granted
  }

  private fun installerPackage(packageName: String): String? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        packageManager().getInstallSourceInfo(packageName).installingPackageName
      } else {
        legacyGetInstallerPackageName(packageManager(), packageName)
      }
    } catch (e: CancellationException) {
      throw e
    } catch (e: PackageManager.NameNotFoundException) {
      Log.w(TAG, "Optional package metadata unavailable for $packageName", e)
      null
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Optional package metadata unavailable for $packageName", e)
      null
    } catch (e: SecurityException) {
      Log.w(TAG, "Optional package metadata unavailable for $packageName", e)
      null
    }
  }

  private suspend fun readPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
    startTime: Long,
  ) {
    val flags = if (includePermissions) PackageManager.GET_PERMISSIONS else 0
    val info =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        packageManager()
          .getPackageInfo(
            packageName,
            PackageManager.PackageInfoFlags.of(flags.toLong()),
          )
      } else {
        legacyGetPackageInfo(packageManager(), packageName, flags)
      }

    val appInfo = info.applicationInfo
    val isSystem =
      (appInfo?.flags ?: 0) and
        (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
    val applicationLabel = appInfo?.let { packageManager().getApplicationLabel(it).toString() }
    val versionCode = PackageInfoCompat.getLongVersionCode(info)
    val installerPackage = installerPackage(packageName)
    val allowBackup = appInfo?.let { (it.flags and ApplicationInfo.FLAG_ALLOW_BACKUP) != 0 }
    val requested = info.requestedPermissions?.toList().orEmpty()
    val granted = grantedPermissions(info, requested, includePermissions)
    val mainActivity =
      try {
        packageManager().getLaunchIntentForPackage(packageName)?.component?.flattenToShortString()
      } catch (e: CancellationException) {
        throw e
      } catch (e: SecurityException) {
        Log.w(TAG, "Optional package metadata unavailable for $packageName", e)
        null
      }

    val totalTime = timeProvider.currentTimeMillis() - startTime
    broadcastPackageInfoResult(
      PackageInfoOutcome(
        requestId = requestId,
        success = true,
        packageName = packageName,
        isSystem = isSystem,
        applicationLabel = applicationLabel,
        versionName = info.versionName,
        versionCode = versionCode,
        installerPackage = installerPackage,
        firstInstallTime = info.firstInstallTime,
        lastUpdateTime = info.lastUpdateTime,
        allowBackup = allowBackup,
        requestedPermissions = requested,
        grantedPermissions = granted,
        mainActivity = mainActivity,
        error = null,
        totalTimeMs = totalTime,
      ),
    )
  }

  /** Resolve the launcher activity component for a package. */
  suspend fun performLaunchIntent(requestId: String?, packageName: String) {
    val startTime = timeProvider.currentTimeMillis()
    withPackageFailures(
      onFailure = { e ->
        Log.e(TAG, "performLaunchIntent failed for $packageName", e)
        broadcastLaunchIntentResult(
          LaunchIntentOutcome(
            requestId = requestId,
            success = false,
            packageName = packageName,
            componentName = null,
            error = "Failed to resolve launch intent: ${e.message}",
            totalTimeMs = timeProvider.currentTimeMillis() - startTime,
          ),
        )
      },
    ) {
      val intent = packageManager().getLaunchIntentForPackage(packageName)
      val component = intent?.component?.flattenToShortString()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      val success = component != null
      broadcastLaunchIntentResult(
        LaunchIntentOutcome(
          requestId = requestId,
          success = success,
          packageName = packageName,
          componentName = component,
          error = if (!success) "No launch intent for $packageName" else null,
          totalTimeMs = totalTime,
        ),
      )
    }
  }

  private suspend fun broadcastInstalledPackagesResult(outcome: InstalledPackagesOutcome) {
    resultSender.send(outcome.requestId, "installed_packages_result", attachPerf = false) { _ ->
      InstalledPackagesResult(
        timestamp = timeProvider.currentTimeMillis(),
        requestId = outcome.requestId,
        success = outcome.success,
        userId = outcome.userId,
        packages = outcome.packages,
        totalTimeMs = outcome.totalTimeMs,
        error = outcome.error,
      )
    }
  }

  private suspend fun broadcastPackageInfoResult(outcome: PackageInfoOutcome) {
    resultSender.send(outcome.requestId, "package_info_result", attachPerf = false) { _ ->
      PackageInfoResult(
        timestamp = timeProvider.currentTimeMillis(),
        requestId = outcome.requestId,
        success = outcome.success,
        packageName = outcome.packageName,
        isSystem = outcome.isSystem,
        applicationLabel = outcome.applicationLabel,
        versionName = outcome.versionName,
        versionCode = outcome.versionCode,
        installerPackage = outcome.installerPackage,
        firstInstallTime = outcome.firstInstallTime,
        lastUpdateTime = outcome.lastUpdateTime,
        allowBackup = outcome.allowBackup,
        requestedPermissions = outcome.requestedPermissions,
        grantedPermissions = outcome.grantedPermissions,
        mainActivity = outcome.mainActivity,
        totalTimeMs = outcome.totalTimeMs,
        error = outcome.error,
      )
    }
  }

  private suspend fun broadcastLaunchIntentResult(outcome: LaunchIntentOutcome) {
    resultSender.send(outcome.requestId, "launch_intent_result", attachPerf = false) { _ ->
      LaunchIntentResult(
        timestamp = timeProvider.currentTimeMillis(),
        requestId = outcome.requestId,
        success = outcome.success,
        packageName = outcome.packageName,
        componentName = outcome.componentName,
        totalTimeMs = outcome.totalTimeMs,
        error = outcome.error,
      )
    }
  }
}

/**
 * Handles the platform failure set shared by these operations. Failure handlers run outside the
 * try.
 */
private inline fun <T> withPackageFailures(onFailure: (Exception) -> T, block: () -> T): T =
  try {
    block()
  } catch (e: kotlinx.coroutines.CancellationException) {
    throw e
  } catch (e: PackageManager.NameNotFoundException) {
    onFailure(e)
  } catch (e: SecurityException) {
    onFailure(e)
  } catch (e: android.content.res.Resources.NotFoundException) {
    onFailure(e)
  } catch (e: IllegalArgumentException) {
    onFailure(e)
  } catch (e: IllegalStateException) {
    onFailure(e)
  } catch (e: java.io.IOException) {
    onFailure(e)
  }

// The int-flags overload is required below API 33.
@Suppress("DEPRECATION")
private fun legacyGetInstalledPackages(packageManager: PackageManager): List<PackageInfo> =
  packageManager.getInstalledPackages(0)

// InstallSourceInfo is unavailable below API 30.
@Suppress("DEPRECATION")
private fun legacyGetInstallerPackageName(
  packageManager: PackageManager,
  packageName: String,
): String? = packageManager.getInstallerPackageName(packageName)

// The int-flags overload is required below API 33.
@Suppress("DEPRECATION")
private fun legacyGetPackageInfo(
  packageManager: PackageManager,
  packageName: String,
  flags: Int,
): PackageInfo = packageManager.getPackageInfo(packageName, flags)

private fun failedPackageInfo(
  requestId: String?,
  packageName: String,
  error: String,
  totalTimeMs: Long,
): PackageInfoOutcome =
  PackageInfoOutcome(
    requestId = requestId,
    success = false,
    packageName = packageName,
    isSystem = false,
    applicationLabel = null,
    versionName = null,
    versionCode = null,
    installerPackage = null,
    firstInstallTime = null,
    lastUpdateTime = null,
    allowBackup = null,
    requestedPermissions = emptyList(),
    grantedPermissions = emptyMap(),
    mainActivity = null,
    error = error,
    totalTimeMs = totalTimeMs,
  )
