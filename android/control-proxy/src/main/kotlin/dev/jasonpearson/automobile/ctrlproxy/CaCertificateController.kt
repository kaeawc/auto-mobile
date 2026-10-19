package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.util.Base64
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.PerfProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.put

/** Device-owner CA certificate operations, with service and platform access supplied per call. */
internal class CaCertificateController(
  private val devicePolicy: DevicePolicy,
  private val packageName: String,
  private val filesDir: () -> File,
  private val perfProvider: PerfProvider,
  private val timeProvider: TimeProvider,
  private val resultBroadcaster: ResultBroadcaster,
  private val responseSender: ResponseSender,
) {
  /** The DevicePolicyManager operations bound to the service's device-admin component. */
  interface DevicePolicy {
    fun isDeviceOwnerApp(packageName: String): Boolean

    fun isAdminActive(): Boolean

    fun installCaCert(certBytes: ByteArray): Boolean

    fun uninstallCaCert(certBytes: ByteArray)

    fun getInstalledCaCerts(): List<ByteArray>
  }

  /** Keeps the service's frame encoder and late-bound WebSocket server behind one seam. */
  interface ResponseSender {
    fun isRunning(): Boolean

    suspend fun broadcastWithPerf(
      type: String,
      requestId: String?,
      buildContent: JsonObjectBuilder.() -> Unit,
    )

    fun getConnectionCount(): Int
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
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        error = "CA certificate install requires API 21+"
        return
      }

      val deviceOwnerError = validateDeviceOwnerStatus()
      if (deviceOwnerError != null) {
        error = deviceOwnerError
        return
      }

      perfProvider.startOperation("decodeCert")
      val certBytes = decodeCertificateBytes(certificate)
      perfProvider.endOperation("decodeCert")
      if (certBytes == null) {
        error = "Certificate payload is empty or invalid"
        return
      }

      alias = computeCertificateAlias(certBytes)

      perfProvider.startOperation("persistCert")
      val stored = writeCaCertToStorage(alias, certBytes)
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
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      error = "Failed to install CA certificate: ${e.message}"
      Log.e(TAG, "Error installing CA certificate", e)
    } finally {
      if (!success && alias != null) {
        deleteCaCertFromStorage(alias)
      }
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastCaCertResult(requestId, "install", success, alias, error, totalTime)
    }
  }

  /** Install a CA certificate from a device file path (device owner only). */
  suspend fun performInstallCaCertificateFromPath(requestId: String?, devicePath: String) {
    val startTime = timeProvider.currentTimeMillis()
    val payload = readCertificatePayloadFromPath(devicePath)
    if (payload == null) {
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastCaCertResult(
        requestId,
        "install",
        false,
        null,
        "Certificate file is empty or unreadable: $devicePath",
        totalTime,
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

    var success = false
    var resolvedAlias: String? = alias
    var error: String? = null

    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
        error = "CA certificate removal requires API 21+"
        return
      }

      val deviceOwnerError = validateDeviceOwnerStatus()
      if (deviceOwnerError != null) {
        error = deviceOwnerError
        return
      }

      perfProvider.startOperation("resolveCert")
      val certBytes =
        when {
          !alias.isNullOrBlank() -> {
            val stored = readCaCertFromStorage(alias)
            stored ?: certificate?.let { decodeCertificateBytes(it) }
          }
          !certificate.isNullOrBlank() -> decodeCertificateBytes(certificate)
          else -> null
        }
      perfProvider.endOperation("resolveCert")

      if (certBytes == null) {
        error =
          if (!alias.isNullOrBlank()) {
            "No stored certificate found for alias: $alias"
          } else {
            "Certificate payload is required for removal"
          }
        return
      }

      if (resolvedAlias.isNullOrBlank()) {
        resolvedAlias = computeCertificateAlias(certBytes)
      }

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
        deleteCaCertFromStorage(resolvedAlias)
      } else {
        error =
          if (isInstalled == null) {
            "Unable to confirm CA certificate removal"
          } else {
            "CA certificate still installed after uninstall"
          }
      }
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      error = "Failed to remove CA certificate: ${e.message}"
      Log.e(TAG, "Error removing CA certificate", e)
    } finally {
      perfProvider.end()
      val totalTime = timeProvider.currentTimeMillis() - startTime
      broadcastCaCertResult(requestId, "remove", success, resolvedAlias, error, totalTime)
    }
  }

  private fun isCaCertInstalled(certBytes: ByteArray): Boolean? {
    return try {
      val installedCerts = devicePolicy.getInstalledCaCerts()
      installedCerts.any { it.contentEquals(certBytes) }
    } catch (e: Exception) {
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
    } catch (e: Exception) {
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

  private fun decodeCertificateBytes(certificate: String): ByteArray? {
    val trimmed = certificate.trim()
    if (trimmed.isEmpty()) {
      return null
    }

    val pemHeader = "-----BEGIN CERTIFICATE-----"
    val pemFooter = "-----END CERTIFICATE-----"
    val normalized =
      if (trimmed.contains(pemHeader)) {
        trimmed.replace(pemHeader, "").replace(pemFooter, "").replace("\\s".toRegex(), "")
      } else {
        trimmed.replace("\\s".toRegex(), "")
      }

    return try {
      Base64.decode(normalized, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      Log.w(TAG, "Failed to decode certificate payload", e)
      null
    }
  }

  private fun readCertificatePayloadFromPath(devicePath: String): String? {
    val certFile = File(devicePath)
    if (!certFile.exists() || !certFile.isFile) {
      Log.w(TAG, "Certificate file not found at $devicePath")
      return null
    }

    val bytes =
      try {
        certFile.readBytes()
      } catch (e: Exception) {
        Log.w(TAG, "Failed to read certificate file at $devicePath", e)
        return null
      }

    if (bytes.isEmpty()) {
      Log.w(TAG, "Certificate file is empty at $devicePath")
      return null
    }

    val text = bytes.toString(Charsets.UTF_8)
    val normalized = text.trim()
    if (normalized.contains("-----BEGIN CERTIFICATE-----")) {
      return normalized
    }

    val compact = normalized.replace("\\s".toRegex(), "")
    if (compact.isNotEmpty() && compact.matches(Regex("^[A-Za-z0-9+/=]+$"))) {
      return compact
    }

    return Base64.encodeToString(bytes, Base64.NO_WRAP)
  }

  private fun computeCertificateAlias(certBytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(certBytes)
    return digest.joinToString("") { formatHexByte(it) }
  }

  private fun writeCaCertToStorage(alias: String, certBytes: ByteArray): Boolean {
    val dir = File(filesDir(), "ca_certs")
    if (!dir.exists() && !dir.mkdirs()) {
      Log.w(TAG, "Failed to create CA cert storage directory: ${dir.absolutePath}")
      return false
    }

    val certFile = File(dir, "$alias.der")
    return try {
      certFile.writeBytes(certBytes)
      true
    } catch (e: Exception) {
      Log.w(TAG, "Failed to write CA cert file: ${certFile.absolutePath}", e)
      false
    }
  }

  private fun readCaCertFromStorage(alias: String): ByteArray? {
    val certFile = File(File(filesDir(), "ca_certs"), "$alias.der")
    if (!certFile.exists()) {
      return null
    }
    return try {
      certFile.readBytes()
    } catch (e: Exception) {
      Log.w(TAG, "Failed to read CA cert file: ${certFile.absolutePath}", e)
      null
    }
  }

  private fun deleteCaCertFromStorage(alias: String) {
    val certFile = File(File(filesDir(), "ca_certs"), "$alias.der")
    if (!certFile.exists()) {
      return
    }
    if (!certFile.delete()) {
      Log.w(TAG, "Failed to delete CA cert file: ${certFile.absolutePath}")
    }
  }

  /** Broadcast CA certificate result to WebSocket clients */
  private suspend fun broadcastCaCertResult(
    requestId: String?,
    action: String,
    success: Boolean,
    alias: String?,
    error: String?,
    totalTimeMs: Long,
  ) {
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping CA cert result broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "ca_cert_result") {
      responseSender.broadcastWithPerf("ca_cert_result", requestId) {
        put("action", action)
        put("success", success)
        put("totalTimeMs", totalTimeMs)
        if (alias != null) {
          put("alias", alias)
        }
        if (error != null) {
          put("error", error)
        }
      }
      Log.d(TAG, "Broadcasted ca_cert_result to ${responseSender.getConnectionCount()} clients")
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
    if (!responseSender.isRunning()) {
      Log.d(TAG, "WebSocket server not running, skipping device owner status broadcast")
      return
    }

    resultBroadcaster.guard(requestId, "device_owner_status_result") {
      val success = error == null
      responseSender.broadcastWithPerf("device_owner_status_result", requestId) {
        put("success", success)
        put("totalTimeMs", totalTimeMs)
        put("packageName", packageName)
        put("isDeviceOwner", isDeviceOwner)
        put("isAdminActive", isAdminActive)
        if (error != null) {
          put("error", error)
        }
      }
      Log.d(
        TAG,
        "Broadcasted device_owner_status_result to ${responseSender.getConnectionCount()} clients",
      )
    }
  }
}
