package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import java.security.InvalidKeyException
import java.security.KeyStoreException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import javax.crypto.Cipher
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class KeystoreUsabilityProbeTest {
  private val authBoundAes =
    ProbeKeyShape(
      algorithm = KeyProperties.KEY_ALGORITHM_AES,
      isPrivate = false,
      userAuthenticationRequired = true,
      purposes = KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      blockModes = listOf(KeyProperties.BLOCK_MODE_GCM),
      encryptionPaddings = listOf(KeyProperties.ENCRYPTION_PADDING_NONE),
    )

  @Test
  fun `ordinary keys are never probed`() {
    assertNull(usabilityProbeFor(authBoundAes.copy(userAuthenticationRequired = false)))
  }

  @Test
  fun `auth-bound AES key begins an encrypt cipher with its own block mode and padding`() {
    assertEquals(
      UsabilityProbe.CipherInit("AES/GCM/NoPadding", Cipher.ENCRYPT_MODE),
      usabilityProbeFor(authBoundAes),
    )
    assertEquals(
      UsabilityProbe.CipherInit("AES/CBC/PKCS7Padding", Cipher.DECRYPT_MODE),
      usabilityProbeFor(
        authBoundAes.copy(
          purposes = KeyProperties.PURPOSE_DECRYPT,
          blockModes = listOf(KeyProperties.BLOCK_MODE_CBC),
          encryptionPaddings = listOf(KeyProperties.ENCRYPTION_PADDING_PKCS7),
        ),
      ),
    )
    assertNull(usabilityProbeFor(authBoundAes.copy(blockModes = emptyList())))
    assertNull(usabilityProbeFor(authBoundAes.copy(purposes = KeyProperties.PURPOSE_SIGN)))
  }

  @Test
  fun `auth-bound HMAC key begins a mac`() {
    val hmac =
      authBoundAes.copy(
        algorithm = KeyProperties.KEY_ALGORITHM_HMAC_SHA256,
        purposes = KeyProperties.PURPOSE_SIGN,
      )
    assertEquals(UsabilityProbe.MacInit("HmacSHA256"), usabilityProbeFor(hmac))
  }

  @Test
  fun `auth-bound private keys begin a signature or RSA decryption`() {
    val ec =
      ProbeKeyShape(
        algorithm = KeyProperties.KEY_ALGORITHM_EC,
        isPrivate = true,
        userAuthenticationRequired = true,
        purposes = KeyProperties.PURPOSE_SIGN,
        digests = listOf(KeyProperties.DIGEST_SHA512, KeyProperties.DIGEST_SHA256),
      )
    assertEquals(UsabilityProbe.SignatureInit("SHA256withECDSA"), usabilityProbeFor(ec))
    val rsaSign =
      ec.copy(
        algorithm = KeyProperties.KEY_ALGORITHM_RSA,
        digests = listOf(KeyProperties.DIGEST_SHA384),
        signaturePaddings = listOf(KeyProperties.SIGNATURE_PADDING_RSA_PSS),
      )
    assertEquals(UsabilityProbe.SignatureInit("SHA384withRSA/PSS"), usabilityProbeFor(rsaSign))
    val rsaDecrypt =
      rsaSign.copy(
        purposes = KeyProperties.PURPOSE_DECRYPT,
        encryptionPaddings = listOf(KeyProperties.ENCRYPTION_PADDING_RSA_PKCS1),
      )
    assertEquals(
      UsabilityProbe.CipherInit("RSA/ECB/PKCS1Padding", Cipher.DECRYPT_MODE),
      usabilityProbeFor(rsaDecrypt),
    )
    assertNull(usabilityProbeFor(ec.copy(digests = emptyList())))
    assertNull(
      usabilityProbeFor(ec.copy(algorithm = "XDH", purposes = KeyProperties.PURPOSE_DECRYPT)),
    )
  }

  @Test
  fun `only authentication exceptions and errors escape the usability check`() {
    listOf(
        KeyPermanentlyInvalidatedException("invalidated"),
        UserNotAuthenticatedException("not authenticated"),
        AssertionError("not a Keystore outcome"),
      )
      .forEach { error ->
        val thrown = runCatching { runUsabilityCheck { throw error } }.exceptionOrNull()
        assertSame(error, thrown)
      }
  }

  @Test
  fun `hardware and unsupported-shape failures are inconclusive, not failures`() {
    // StrongBox and other hardware keys can reject this operation shape; presence must stand.
    listOf(
        InvalidKeyException("unsupported block mode"),
        ProviderException("StrongBox rejected the operation"),
        KeyStoreException("store unavailable"),
        UnrecoverableKeyException("entry unreadable"),
        IllegalStateException("provider state"),
      )
      .forEach { error -> runUsabilityCheck { throw error } }
  }

  @Test
  fun `real backend without an AndroidKeyStore provider leaves the read unchanged`() {
    // Robolectric registers no AndroidKeyStore provider, so opening the store fails.
    AndroidKeystoreBackend().verifyUsable("aes")
  }
}
