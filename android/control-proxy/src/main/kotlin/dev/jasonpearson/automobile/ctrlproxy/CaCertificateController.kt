package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import java.io.File
import kotlinx.coroutines.CancellationException

/** Platform access bound to the service's device-admin component and private storage. */
internal data class CaCertificateDependencies(
  val devicePolicy: CaCertificateController.DevicePolicy,
  val packageName: String,
  val filesDir: () -> File,
)

/** Device-owner CA certificate operations, with service and platform access supplied per call. */
internal class CaCertificateController(
  dependencies: CaCertificateDependencies,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  private val resultSender: ResultSender,
) {
  private val devicePolicy = dependencies.devicePolicy
  private val packageName = dependencies.packageName
  private val certificateStorage = CaCertificateStorage(dependencies.filesDir)

  /** The DevicePolicyManager operations bound to the service's device-admin component. */
  interface DevicePolicy {
    fun isDeviceOwnerApp(packageName: String): Boolean

    fun isAdminActive(): Boolean

    fun installCaCert(certBytes: ByteArray): Boolean

    fun uninstallCaCert(certBytes: ByteArray)

    fun getInstalledCaCerts(): List<ByteArray>
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  /** Install a CA certificate via DevicePolicyManager (device owner only). */
  suspend fun performInstallCaCertificate(requestId: String?, certificate: String) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performInstallCaCertificate")
    perfProvider.serial("installCaCert")

    var success = false
    var alias: String? = null
    var error: String? = null

    try {
      withCaPolicyFailures(
        onFailure = { e ->
          error = "Failed to install CA certificate: ${e.message}"
          Log.e(TAG, "Error installing CA certificate", e)
        },
      ) {
        val deviceOwnerError = validateDeviceOwnerStatus()
        if (deviceOwnerError != null) {
          error = deviceOwnerError
          return
        }

        perfProvider.startOperation("decodeCert")
        val certBytes = certificateStorage.decodeCertificateBytes(certificate)
        perfProvider.endOperation("decodeCert")
        if (certBytes == null) {
          error = "Certificate payload is empty or invalid"
          return
        }

        alias = certificateStorage.computeCertificateAlias(certBytes)

        perfProvider.startOperation("persistCert")
        val stored = certificateStorage.writeCaCertToStorage(alias, certBytes)
        perfProvider.endOperation("persistCert")
        if (!stored) {
          error = "Failed to persist certificate for alias: $alias"
          return
        }

        perfProvider.startOperation("installCert")
        try {
          success = devicePolicy.installCaCert(certBytes)
        } finally {
          perfProvider.endOperation("installCert")
        }
        if (!success) {
          error = "DevicePolicyManager.installCaCert returned false"
        }
      }
    } finally {
      if (!success && alias != null) {
        certificateStorage.deleteCaCertFromStorage(alias)
      }
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastCaCertResult(
        CaCertificateResult(requestId, "install", success, alias, error, totalTime),
      )
    }
  }

  /** Install a CA certificate from a device file path (device owner only). */
  suspend fun performInstallCaCertificateFromPath(requestId: String?, devicePath: String) {
    val startTime = timeProvider.currentTimeMillis()
    val payload = certificateStorage.readCertificatePayloadFromPath(devicePath)
    if (payload == null) {
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastCaCertResult(
        CaCertificateResult(
          requestId,
          "install",
          false,
          null,
          "Certificate file is empty or unreadable: $devicePath",
          totalTime,
        ),
      )
      return
    }

    performInstallCaCertificate(requestId, payload)
  }

  /** Remove a CA certificate via DevicePolicyManager (device owner only). */
  suspend fun performRemoveCaCertificate(
    requestId: String?,
    alias: String?,
    certificate: String?,
  ) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performRemoveCaCertificate")
    perfProvider.serial("removeCaCert")

    RemoveCertificate(alias, certificate).run(requestId, startTime)
  }

  private inner class RemoveCertificate(
    private val alias: String?,
    private val certificate: String?,
  ) {
    private var success = false
    private var resolvedAlias: String? = alias
    private var error: String? = null

    suspend fun run(requestId: String?, startTime: Long) {
      try {
        withCaPolicyFailures(
          onFailure = { e ->
            error = "Failed to remove CA certificate: ${e.message}"
            Log.e(TAG, "Error removing CA certificate", e)
          },
        ) {
          remove()
        }
      } finally {
        perfProvider.end()
        val totalTime = timeProvider.currentTimeMillis() - startTime
        broadcastCaCertResult(
          CaCertificateResult(requestId, "remove", success, resolvedAlias, error, totalTime),
        )
      }
    }

    private fun remove() {
      val deviceOwnerError = validateDeviceOwnerStatus()
      if (deviceOwnerError != null) {
        error = deviceOwnerError
        return
      }

      val certBytes = resolveCertificate()

      if (certBytes == null) {
        error =
          if (!alias.isNullOrBlank()) {
            "No stored certificate found for alias: $alias"
          } else {
            "Certificate payload is required for removal"
          }
        return
      }

      val previousAlias = resolvedAlias
      val certificateAlias =
        if (previousAlias.isNullOrBlank()) certificateStorage.computeCertificateAlias(certBytes)
        else previousAlias
      resolvedAlias = certificateAlias

      val wasInstalled = isCaCertInstalled(certBytes)
      if (wasInstalled == false) {
        error = "CA certificate is not installed"
        return
      }

      perfProvider.startOperation("removeCert")
      try {
        devicePolicy.uninstallCaCert(certBytes)
      } finally {
        perfProvider.endOperation("removeCert")
      }
      val isInstalled = isCaCertInstalled(certBytes)
      success = isInstalled == false
      if (success) {
        certificateStorage.deleteCaCertFromStorage(certificateAlias)
      } else {
        error =
          if (isInstalled == null) {
            "Unable to confirm CA certificate removal"
          } else {
            "CA certificate still installed after uninstall"
          }
      }
    }

    private fun resolveCertificate(): ByteArray? {
      perfProvider.startOperation("resolveCert")
      val certBytes =
        when {
          !alias.isNullOrBlank() -> {
            val stored = certificateStorage.readCaCertFromStorage(alias)
            stored ?: certificate?.let { certificateStorage.decodeCertificateBytes(it) }
          }
          !certificate.isNullOrBlank() -> certificateStorage.decodeCertificateBytes(certificate)
          else -> null
        }
      perfProvider.endOperation("resolveCert")

      return certBytes
    }
  }

  private fun isCaCertInstalled(certBytes: ByteArray): Boolean? {
    return try {
      val installedCerts = devicePolicy.getInstalledCaCerts()
      installedCerts.any { it.contentEquals(certBytes) }
    } catch (e: SecurityException) {
      Log.w(TAG, "Unable to query installed CA certificates", e)
      null
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.w(TAG, "Unable to query installed CA certificates", e)
      null
    }
  }

  /** Report device owner status for the accessibility service package. */
  suspend fun performGetDeviceOwnerStatus(requestId: String?) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(TAG, "performGetDeviceOwnerStatus")
    perfProvider.serial("deviceOwnerStatus")

    var isDeviceOwner = false
    var isAdminActive = false
    var error: String? = null

    try {
      isDeviceOwner = devicePolicy.isDeviceOwnerApp(packageName)
      isAdminActive = devicePolicy.isAdminActive()
    } catch (e: CancellationException) {
      throw e
    } catch (e: SecurityException) {
      error = "Failed to read device owner status: ${e.message}"
      Log.e(TAG, "Error reading device owner status", e)
    } catch (e: IllegalArgumentException) {
      error = "Failed to read device owner status: ${e.message}"
      Log.e(TAG, "Error reading device owner status", e)
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      error = "Failed to read device owner status: ${e.message}"
      Log.e(TAG, "Error reading device owner status", e)
    } finally {
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastDeviceOwnerStatusResult(
        requestId,
        isDeviceOwner,
        isAdminActive,
        error,
        totalTime,
      )
    }
  }

  private fun validateDeviceOwnerStatus(): String? {
    if (!devicePolicy.isDeviceOwnerApp(packageName)) {
      return "Device owner is not active for $packageName"
    }
    if (!devicePolicy.isAdminActive()) {
      return "Device admin receiver is not active for $packageName"
    }
    return null
  }

  /** Broadcast CA certificate result to WebSocket clients */
  private suspend fun broadcastCaCertResult(outcome: CaCertificateResult) {
    resultSender.sendFrame(outcome.requestId, "ca_cert_result") { perfTiming ->
      caCertResultFrame(outcome, perfTiming)
    }
  }

  /** Broadcast device owner status result to WebSocket clients */
  private suspend fun broadcastDeviceOwnerStatusResult(
    requestId: String?,
    isDeviceOwner: Boolean,
    isAdminActive: Boolean,
    error: String?,
    totalTimeMs: Long,
  ) {
    resultSender.sendFrame(requestId, "device_owner_status_result") { perfTiming ->
      deviceOwnerStatusResultFrame(
        DeviceOwnerResult(
          requestId = requestId,
          packageName = packageName,
          isDeviceOwner = isDeviceOwner,
          isAdminActive = isAdminActive,
          error = error,
          totalTimeMs = totalTimeMs,
        ),
        perfTiming,
      )
    }
  }
}

/**
 * Handles the platform failure set shared by these operations. Failure handlers run outside the
 * try.
 */
private inline fun <T> withCaPolicyFailures(onFailure: (Exception) -> T, block: () -> T): T =
  try {
    block()
  } catch (e: kotlinx.coroutines.CancellationException) {
    throw e
  } catch (e: SecurityException) {
    onFailure(e)
  } catch (e: IllegalArgumentException) {
    onFailure(e)
  } catch (e: IllegalStateException) {
    onFailure(e)
  } catch (e: UnsupportedOperationException) {
    onFailure(e)
  } catch (e: java.security.NoSuchAlgorithmException) {
    onFailure(e)
  }
