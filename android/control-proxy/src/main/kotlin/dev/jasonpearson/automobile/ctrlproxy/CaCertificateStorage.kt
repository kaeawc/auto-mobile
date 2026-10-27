package dev.jasonpearson.automobile.ctrlproxy

import android.util.Base64
import android.util.Log
import java.io.File
import java.security.MessageDigest

/** Certificate payload decoding and private-file persistence. */
internal class CaCertificateStorage(private val filesDir: () -> File) {
  private companion object {
    const val TAG = "CtrlProxy"
  }

  fun decodeCertificateBytes(certificate: String): ByteArray? {
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

  fun readCertificatePayloadFromPath(devicePath: String): String? {
    val certFile = File(devicePath)
    if (!certFile.exists() || !certFile.isFile) {
      Log.w(TAG, "Certificate file not found at $devicePath")
      return null
    }

    val bytes =
      try {
        certFile.readBytes()
      } catch (e: java.io.IOException) {
        Log.w(TAG, "Failed to read certificate file at $devicePath", e)
        return null
      } catch (e: SecurityException) {
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

  fun computeCertificateAlias(certBytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(certBytes)
    return digest.joinToString("") { formatHexByte(it) }
  }

  fun writeCaCertToStorage(alias: String, certBytes: ByteArray): Boolean {
    val dir = File(filesDir(), "ca_certs")
    if (!dir.exists() && !dir.mkdirs()) {
      Log.w(TAG, "Failed to create CA cert storage directory: ${dir.absolutePath}")
      return false
    }

    val certFile = File(dir, "$alias.der")
    return try {
      certFile.writeBytes(certBytes)
      true
    } catch (e: java.io.IOException) {
      Log.w(TAG, "Failed to write CA cert file: ${certFile.absolutePath}", e)
      false
    } catch (e: SecurityException) {
      Log.w(TAG, "Failed to write CA cert file: ${certFile.absolutePath}", e)
      false
    }
  }

  fun readCaCertFromStorage(alias: String): ByteArray? {
    val certFile = File(File(filesDir(), "ca_certs"), "$alias.der")
    if (!certFile.exists()) {
      return null
    }
    return try {
      certFile.readBytes()
    } catch (e: java.io.IOException) {
      Log.w(TAG, "Failed to read CA cert file: ${certFile.absolutePath}", e)
      null
    } catch (e: SecurityException) {
      Log.w(TAG, "Failed to read CA cert file: ${certFile.absolutePath}", e)
      null
    }
  }

  fun deleteCaCertFromStorage(alias: String) {
    val certFile = File(File(filesDir(), "ca_certs"), "$alias.der")
    if (!certFile.exists()) {
      return
    }
    if (!certFile.delete()) {
      Log.w(TAG, "Failed to delete CA cert file: ${certFile.absolutePath}")
    }
  }
}
