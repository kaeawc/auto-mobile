package dev.jasonpearson.automobile.ctrlproxy

import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.InstalledPackageRecord
import dev.jasonpearson.automobile.protocol.InstalledPackagesResult
import dev.jasonpearson.automobile.protocol.LaunchIntentResult
import dev.jasonpearson.automobile.protocol.PackageInfoResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.CancellationException

/** Installed-package enumeration, package metadata and launcher-activity resolution. */
internal class PackageController(
  private val packageManager: () -> PackageManager,
  private val currentUserId: () -> Int,
  private val timeProvider: TimeProvider,
  private val resultBroadcaster: ResultBroadcaster,
  private val responseSender: ResponseSender,
) {
  /** Keeps the service's late-bound WebSocket server behind one seam. */
  interface ResponseSender {
    fun isRunning(): Boolean

    suspend fun broadcast(response: WebSocketResponse)
  }

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
        requestId = requestId,
        success = false,
        userId = currentUserId,
        packages = emptyList(),
        error =
          "Requested userId=$userId differs from service userId=$currentUserId; ADB fallback required",
        totalTimeMs = timeProvider.currentTimeMillis() - startTime,
      )
      return
    }

    try {
      val infos =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          packageManager()
            .getInstalledPackages(
              PackageManager.PackageInfoFlags.of(0L),
            )
        } else {
          @Suppress("DEPRECATION") packageManager().getInstalledPackages(0)
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
        val versionCode =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
          else @Suppress("DEPRECATION") info.versionCode.toLong()
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
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastInstalledPackagesResult(
        requestId = requestId,
        success = true,
        userId = currentUserId,
        packages = records,
        error = null,
        totalTimeMs = totalTime,
      )
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "performInstalledPackages failed", e)
      broadcastInstalledPackagesResult(
        requestId = requestId,
        success = false,
        userId = currentUserId,
        packages = emptyList(),
        error = "Failed to enumerate packages: ${e.message}",
        totalTimeMs = timeProvider.currentTimeMillis() - startTime,
      )
    }
  }

  /** Read package metadata via PackageManager. */
  suspend fun performPackageInfo(
    requestId: String?,
    packageName: String,
    includePermissions: Boolean,
  ) {
    val startTime = timeProvider.currentTimeMillis()
    try {
      val flags = if (includePermissions) PackageManager.GET_PERMISSIONS else 0
      val info =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          packageManager()
            .getPackageInfo(
              packageName,
              PackageManager.PackageInfoFlags.of(flags.toLong()),
            )
        } else {
          @Suppress("DEPRECATION") packageManager().getPackageInfo(packageName, flags)
        }

      val appInfo = info.applicationInfo
      val isSystem =
        (appInfo?.flags ?: 0) and
          (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
      val applicationLabel = appInfo?.let { packageManager().getApplicationLabel(it).toString() }
      val versionCode =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode
        else @Suppress("DEPRECATION") info.versionCode.toLong()
      val installerPackage =
        try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            packageManager().getInstallSourceInfo(packageName).installingPackageName
          } else {
            @Suppress("DEPRECATION") packageManager().getInstallerPackageName(packageName)
          }
        } catch (e: CancellationException) {
          throw e
        } catch (e: Exception) {
          null
        }
      val allowBackup = appInfo?.let { (it.flags and ApplicationInfo.FLAG_ALLOW_BACKUP) != 0 }
      val requested = info.requestedPermissions?.toList().orEmpty()
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
      val mainActivity =
        try {
          packageManager().getLaunchIntentForPackage(packageName)?.component?.flattenToShortString()
        } catch (e: CancellationException) {
          throw e
        } catch (e: Exception) {
          null
        }

      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastPackageInfoResult(
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
      )
    } catch (e: PackageManager.NameNotFoundException) {
      broadcastPackageInfoResult(
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
        error = "Package not installed or not visible: $packageName",
        totalTimeMs = timeProvider.currentTimeMillis() - startTime,
      )
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "performPackageInfo failed for $packageName", e)
      broadcastPackageInfoResult(
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
        error = "Failed to read package info: ${e.message}",
        totalTimeMs = timeProvider.currentTimeMillis() - startTime,
      )
    }
  }

  /** Resolve the launcher activity component for a package. */
  suspend fun performLaunchIntent(requestId: String?, packageName: String) {
    val startTime = timeProvider.currentTimeMillis()
    try {
      val intent = packageManager().getLaunchIntentForPackage(packageName)
      val component = intent?.component?.flattenToShortString()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      val success = component != null
      broadcastLaunchIntentResult(
        requestId = requestId,
        success = success,
        packageName = packageName,
        componentName = component,
        error = if (!success) "No launch intent for $packageName" else null,
        totalTimeMs = totalTime,
      )
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      Log.e(TAG, "performLaunchIntent failed for $packageName", e)
      broadcastLaunchIntentResult(
        requestId = requestId,
        success = false,
        packageName = packageName,
        componentName = null,
        error = "Failed to resolve launch intent: ${e.message}",
        totalTimeMs = timeProvider.currentTimeMillis() - startTime,
      )
    }
  }

  private suspend fun broadcastInstalledPackagesResult(
    requestId: String?,
    success: Boolean,
    userId: Int,
    packages: List<InstalledPackageRecord>,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) return
    resultBroadcaster.guard(requestId, "installed_packages_result") {
      responseSender.broadcast(
        InstalledPackagesResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = success,
          userId = userId,
          packages = packages,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastPackageInfoResult(
    requestId: String?,
    success: Boolean,
    packageName: String,
    isSystem: Boolean,
    applicationLabel: String?,
    versionName: String?,
    versionCode: Long?,
    installerPackage: String?,
    firstInstallTime: Long?,
    lastUpdateTime: Long?,
    allowBackup: Boolean?,
    requestedPermissions: List<String>,
    grantedPermissions: Map<String, Boolean>,
    mainActivity: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) return
    resultBroadcaster.guard(requestId, "package_info_result") {
      responseSender.broadcast(
        PackageInfoResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = success,
          packageName = packageName,
          isSystem = isSystem,
          applicationLabel = applicationLabel,
          versionName = versionName,
          versionCode = versionCode,
          installerPackage = installerPackage,
          firstInstallTime = firstInstallTime,
          lastUpdateTime = lastUpdateTime,
          allowBackup = allowBackup,
          requestedPermissions = requestedPermissions,
          grantedPermissions = grantedPermissions,
          mainActivity = mainActivity,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }

  private suspend fun broadcastLaunchIntentResult(
    requestId: String?,
    success: Boolean,
    packageName: String,
    componentName: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) return
    resultBroadcaster.guard(requestId, "launch_intent_result") {
      responseSender.broadcast(
        LaunchIntentResult(
          timestamp = timeProvider.currentTimeMillis(),
          requestId = requestId,
          success = success,
          packageName = packageName,
          componentName = componentName,
          totalTimeMs = totalTimeMs,
          error = error,
        ),
      )
    }
  }
}
