package dev.jasonpearson.automobile.sdk.keystore

import android.app.KeyguardManager
import android.content.Context
import android.util.Log
import java.security.KeyStore

internal enum class EntryCategory {
  KEY,
  // Reserved for backends that can distinguish key types without retrieving material.
  SECRET_KEY,
  PRIVATE_KEY,
  CERTIFICATE,
  UNKNOWN,
}

/**
 * Deliberately cannot retrieve keys, entries, certificates, chains, or credential bytes.
 * AndroidKeyStore directly implements isKeyEntry/isCertificateEntry; entryInstanceOf can load a
 * certificate internally. Key subtypes therefore remain reserved; real key entries report KEY. A
 * false presence result means not present or not observable: the SPI swallows metadata errors.
 * [verifyUsable] loads a key handle internally to begin one operation but never returns it.
 */
internal interface KeystoreBackend {
  fun deleteAlias(alias: String)

  fun containsAlias(alias: String): Boolean

  fun entryCategory(alias: String): EntryCategory

  /**
   * For a present auth-bound key, begins one operation and throws UserNotAuthenticatedException or
   * KeyPermanentlyInvalidatedException when the key cannot be used. Returns normally for ordinary
   * keys and whenever the check is inconclusive (#17294).
   */
  fun verifyUsable(alias: String)
}

internal class AndroidKeystoreBackend : KeystoreBackend {
  // Lazy: disabled/discovery/undeclared requests never open AndroidKeyStore.
  private val store by lazy { KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) } }

  override fun deleteAlias(alias: String) = store.deleteEntry(alias)

  override fun containsAlias(alias: String): Boolean = store.containsAlias(alias)

  override fun entryCategory(alias: String): EntryCategory =
    when {
      store.isKeyEntry(alias) -> EntryCategory.KEY
      store.isCertificateEntry(alias) -> EntryCategory.CERTIFICATE
      else -> EntryCategory.UNKNOWN
    }

  override fun verifyUsable(alias: String) = runUsabilityCheck {
    store.getKey(alias, null)?.let(::beginUsabilityProbe)
  }
}

internal enum class DeviceLockState {
  LOCKED,
  UNLOCKED,
  UNKNOWN,
}

internal fun interface DeviceLockProbe {
  fun state(): DeviceLockState
}

internal class AndroidDeviceLockProbe(private val context: Context?) : DeviceLockProbe {
  override fun state(): DeviceLockState =
    try {
      val manager = context?.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      when {
        manager == null -> DeviceLockState.UNKNOWN
        manager.isDeviceLocked -> DeviceLockState.LOCKED
        else -> DeviceLockState.UNLOCKED
      }
    } catch (error: Exception) {
      Log.w("KeystoreTestState", "Device lock probe unavailable", error)
      DeviceLockState.UNKNOWN
    }
}
