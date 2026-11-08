package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Log
import java.security.Key
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.Signature
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec

/**
 * One Keystore operation to begin (never finish) on an auth-bound key. Beginning it is where
 * AndroidKeyStore reports UserNotAuthenticatedException or KeyPermanentlyInvalidatedException;
 * presence and category lookups never do (#17294).
 */
internal sealed interface UsabilityProbe {
  data class CipherInit(
    val transformation: String,
    val opmode: Int,
    val iv: ProbeIv = ProbeIv.NONE,
  ) : UsabilityProbe

  data class SignatureInit(val algorithm: String) : UsabilityProbe

  data class MacInit(val algorithm: String) : UsabilityProbe
}

/**
 * Decryption in an IV mode needs caller parameters, or init fails before Keystore is reached. A
 * synthetic all-zero IV is safe because the operation is only begun, never fed data.
 */
internal enum class ProbeIv {
  NONE,
  BLOCK_16,
  GCM_12,
}

/** The KeyInfo fields the probe choice depends on; never key material. */
internal data class ProbeKeyShape(
  val algorithm: String,
  val isPrivate: Boolean,
  val userAuthenticationRequired: Boolean,
  val purposes: Int,
  val blockModes: List<String> = emptyList(),
  val encryptionPaddings: List<String> = emptyList(),
  val signaturePaddings: List<String> = emptyList(),
  val digests: List<String> = emptyList(),
)

/**
 * Returns null when the key is not auth-bound (ordinary keys are never probed) or no operation the
 * key authorizes can be begun without parameters; the check is then inconclusive, not a failure.
 */
internal fun usabilityProbeFor(shape: ProbeKeyShape): UsabilityProbe? {
  if (!shape.userAuthenticationRequired) return null
  val algorithm = shape.algorithm
  return when {
    algorithm.startsWith("Hmac", ignoreCase = true) ->
      if (shape.allows(KeyProperties.PURPOSE_SIGN)) UsabilityProbe.MacInit(algorithm) else null
    shape.isPrivate -> privateKeyProbe(shape)
    algorithm.equals(KeyProperties.KEY_ALGORITHM_AES, ignoreCase = true) -> aesProbe(shape)
    else -> null
  }
}

private fun ProbeKeyShape.allows(purpose: Int): Boolean = purposes and purpose != 0

private fun aesProbe(shape: ProbeKeyShape): UsabilityProbe? {
  val mode =
    when {
      shape.allows(KeyProperties.PURPOSE_ENCRYPT) -> Cipher.ENCRYPT_MODE
      shape.allows(KeyProperties.PURPOSE_DECRYPT) -> Cipher.DECRYPT_MODE
      else -> return null
    }
  val blockMode = shape.blockModes.firstOrNull() ?: return null
  val padding = shape.encryptionPaddings.firstOrNull() ?: KeyProperties.ENCRYPTION_PADDING_NONE
  val iv =
    when {
      mode == Cipher.ENCRYPT_MODE -> ProbeIv.NONE
      blockMode == KeyProperties.BLOCK_MODE_GCM -> ProbeIv.GCM_12
      blockMode == KeyProperties.BLOCK_MODE_ECB -> ProbeIv.NONE
      else -> ProbeIv.BLOCK_16
    }
  return UsabilityProbe.CipherInit("AES/$blockMode/$padding", mode, iv)
}

private fun privateKeyProbe(shape: ProbeKeyShape): UsabilityProbe? {
  if (shape.allows(KeyProperties.PURPOSE_SIGN))
    signatureProbe(shape)?.let {
      return it
    }
  if (
    !shape.allows(KeyProperties.PURPOSE_DECRYPT) ||
      !shape.algorithm.equals(KeyProperties.KEY_ALGORITHM_RSA, ignoreCase = true)
  ) {
    return null
  }
  val padding =
    listOf(KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1, KeyProperties.ENCRYPTION_PADDING_NONE)
      .firstOrNull { it in shape.encryptionPaddings } ?: return null
  return UsabilityProbe.CipherInit("RSA/ECB/$padding", Cipher.DECRYPT_MODE)
}

private fun signatureProbe(shape: ProbeKeyShape): UsabilityProbe? {
  val digest =
    (shape.digests.firstOrNull { it == KeyProperties.DIGEST_SHA256 } ?: shape.digests.firstOrNull())
      ?.replace("-", "") ?: return null
  val suffix =
    when {
      shape.algorithm.equals(KeyProperties.KEY_ALGORITHM_EC, ignoreCase = true) -> "withECDSA"
      !shape.algorithm.equals(KeyProperties.KEY_ALGORITHM_RSA, ignoreCase = true) -> return null
      KeyProperties.SIGNATURE_PADDING_RSA_PKCS1 in shape.signaturePaddings -> "withRSA"
      KeyProperties.SIGNATURE_PADDING_RSA_PSS in shape.signaturePaddings -> "withRSA/PSS"
      else -> return null
    }
  return UsabilityProbe.SignatureInit("$digest$suffix")
}

/**
 * Runs [check] and rethrows only the two authentication exceptions the metadata mapping reports.
 * Anything else (an unsupported transformation, a StrongBox or hardware key that rejects this
 * operation shape, an unreadable entry) is inconclusive and leaves the presence report unchanged.
 */
internal fun runUsabilityCheck(check: () -> Unit) {
  val failure = runCatching(check).exceptionOrNull() ?: return
  val authentication =
    failure is UserNotAuthenticatedException || failure is KeyPermanentlyInvalidatedException
  // Errors are not Keystore outcomes and keep propagating.
  if (authentication || failure !is Exception) throw failure
  // Inconclusive by design: never include exception text or key material in logs.
  Log.d(
    "KeystoreTestState",
    "Keystore usability check inconclusive: ${failure.javaClass.simpleName}",
  )
}

/** Real-SPI glue: the key handle stays inside this function and is never returned. */
internal fun beginUsabilityProbe(key: Key) {
  val info =
    when (key) {
      is SecretKey ->
        SecretKeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE)
          .getKeySpec(key, KeyInfo::class.java) as KeyInfo
      is PrivateKey ->
        KeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE).getKeySpec(key, KeyInfo::class.java)
      else -> return
    }
  val shape =
    ProbeKeyShape(
      algorithm = key.algorithm,
      isPrivate = key is PrivateKey,
      userAuthenticationRequired = info.isUserAuthenticationRequired,
      purposes = info.purposes,
      blockModes = info.blockModes.toList(),
      encryptionPaddings = info.encryptionPaddings.toList(),
      signaturePaddings = info.signaturePaddings.toList(),
      digests = info.digests.toList(),
    )
  // The begun operation is never updated or finished; the provider aborts it when collected.
  when (val probe = usabilityProbeFor(shape)) {
    is UsabilityProbe.CipherInit -> beginCipher(probe, key)
    is UsabilityProbe.SignatureInit ->
      Signature.getInstance(probe.algorithm).initSign(key as PrivateKey)
    is UsabilityProbe.MacInit -> Mac.getInstance(probe.algorithm).init(key)
    null -> Unit
  }
}

internal const val ANDROID_KEYSTORE = "AndroidKeyStore"

private fun beginCipher(probe: UsabilityProbe.CipherInit, key: Key) {
  val cipher = Cipher.getInstance(probe.transformation)
  when (probe.iv) {
    ProbeIv.NONE -> cipher.init(probe.opmode, key)
    ProbeIv.BLOCK_16 -> cipher.init(probe.opmode, key, IvParameterSpec(ByteArray(AES_BLOCK_BYTES)))
    ProbeIv.GCM_12 ->
      cipher.init(probe.opmode, key, GCMParameterSpec(GCM_TAG_BITS, ByteArray(GCM_NONCE_BYTES)))
  }
}

private const val AES_BLOCK_BYTES = 16
private const val GCM_NONCE_BYTES = 12
private const val GCM_TAG_BITS = 128
