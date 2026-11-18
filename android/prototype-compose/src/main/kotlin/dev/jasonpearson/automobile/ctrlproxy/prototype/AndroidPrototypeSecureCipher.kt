package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The only hardware-dependent seam; JVM tests supply ordinary AES keys. */
internal interface PrototypeSecureKeyProvider {
  fun key(alias: String, create: Boolean): SecretKey?

  fun delete(alias: String)
}

internal class AndroidPrototypeSecureKeyProvider : PrototypeSecureKeyProvider {
  private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  override fun key(alias: String, create: Boolean): SecretKey? {
    (store().getKey(alias, null) as? SecretKey)?.let {
      return it
    }
    if (!create) return null
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(
        KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
          .setKeySize(256)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setUserAuthenticationRequired(false)
          .setRandomizedEncryptionRequired(true)
          .build(),
      )
      generateKey()
    }
  }

  override fun delete(alias: String) = store().deleteEntry(alias)
}

internal class PrototypeSecureCipher(
  private val keys: PrototypeSecureKeyProvider,
  private val random: SecureRandom = SecureRandom(),
) {
  fun encrypt(id: String, value: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    // The provider generates a fresh random 96-bit IV; AndroidKeyStore refuses caller IVs.
    cipher.init(Cipher.ENCRYPT_MODE, keys.key(alias(id), true), random)
    check(cipher.iv.size == IV_BYTES) { "Secure storage cipher unavailable" }
    cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
    return cipher.iv + cipher.doFinal(value)
  }

  fun decrypt(id: String, value: ByteArray): ByteArray {
    if (value.size < IV_BYTES + TAG_BYTES)
      throw GeneralSecurityException("Secure storage unavailable")
    val key =
      keys.key(alias(id), false) ?: throw GeneralSecurityException("Secure storage unavailable")
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      key,
      GCMParameterSpec(TAG_BYTES * 8, value.copyOfRange(0, IV_BYTES)),
    )
    cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
    return cipher.doFinal(value.copyOfRange(IV_BYTES, value.size))
  }

  fun delete(id: String) = keys.delete(alias(id))

  private fun alias(id: String) = "dev.automobile.prototype.${prototypeSecureFileName(id)}"

  private companion object {
    const val IV_BYTES = 12
    const val TAG_BYTES = 16
  }
}

internal fun prototypeSecureFileName(id: String) =
  "${prototypeIdSlugPrefix(id)}-${sha256Hex(id.toByteArray(Charsets.UTF_8))}"
