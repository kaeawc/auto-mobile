package dev.jasonpearson.automobile.ctrlproxy.storage

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.util.UUID

/** Only the temporary alias and public certificates cross this boundary. */
internal interface AttestationKeyStore {
  fun generate(alias: String, challenge: ByteArray)

  fun certificateChain(alias: String): List<ByteArray>

  fun delete(alias: String)
}

internal class AndroidAttestationKeyStore : AttestationKeyStore {
  private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  override fun generate(alias: String, challenge: ByteArray) {
    val spec =
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setAttestationChallenge(challenge)
        .build()
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
      initialize(spec)
      generateKeyPair()
    }
  }

  override fun certificateChain(alias: String): List<ByteArray> =
    store.getCertificateChain(alias)?.map { it.encoded }
      ?: error("AndroidKeyStore returned no attestation chain")

  override fun delete(alias: String) = store.deleteEntry(alias)
}

/** A one-shot export; even failed generation/read attempts remove their unique alias. */
internal class KeystoreAttestation(
  private val store: AttestationKeyStore,
  private val alias: () -> String = { "automobile-attestation-${UUID.randomUUID()}" },
  private val challenge: () -> ByteArray = { ByteArray(32).also { SecureRandom().nextBytes(it) } },
  // android.util.Base64 rather than java.util.Base64, which needs API 26 (minSdk is 24).
  private val encode: (ByteArray) -> String = { Base64.encodeToString(it, Base64.NO_WRAP) },
) {
  fun export(): List<String> {
    val temporaryAlias = alias()
    try {
      store.generate(temporaryAlias, challenge())
      val certificates = store.certificateChain(temporaryAlias)
      check(certificates.size >= 2) { "AndroidKeyStore returned an incomplete attestation chain" }
      return certificates.map(encode)
    } finally {
      store.delete(temporaryAlias)
    }
  }
}
