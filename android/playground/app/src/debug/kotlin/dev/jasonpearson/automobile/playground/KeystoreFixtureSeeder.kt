package dev.jasonpearson.automobile.playground

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.crypto.KeyGenerator

/** Only these two aliases may be created by the debug fixture. */
internal class KeystoreFixtureSeeder(private val store: KeystoreFixtureStore) {
  fun seed() {
    if (!store.containsAlias(KEY_ALIAS)) store.createKey(KEY_ALIAS)
    if (!store.containsAlias(CERTIFICATE_ALIAS)) store.createCertificate(CERTIFICATE_ALIAS)
  }

  companion object {
    const val KEY_ALIAS = "automobile.fixture"
    const val CERTIFICATE_ALIAS = "automobile.fixture.certificate"
  }
}

internal interface KeystoreFixtureStore {
  fun containsAlias(alias: String): Boolean

  fun createKey(alias: String)

  fun createCertificate(alias: String)
}

internal class AndroidKeystoreFixtureStore : KeystoreFixtureStore {
  private val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  override fun containsAlias(alias: String): Boolean = store.containsAlias(alias)

  override fun createKey(alias: String) {
    require(alias == KeystoreFixtureSeeder.KEY_ALIAS)
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(
        KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setUserAuthenticationRequired(false)
          .build(),
      )
      generateKey()
    }
  }

  override fun createCertificate(alias: String) {
    require(alias == KeystoreFixtureSeeder.CERTIFICATE_ALIAS)
    val certificate =
      CertificateFactory.getInstance("X.509").generateCertificate(CERTIFICATE_PEM.byteInputStream())
    store.setCertificateEntry(alias, certificate)
  }

  companion object {
    // Public self-signed certificate generated once with openssl; no private key is retained.
    private val CERTIFICATE_PEM =
      """
      -----BEGIN CERTIFICATE-----
      MIIDCDCCAfCgAwIBAgIUR0PLZ60i+lGiLac6Ve8f3kTEy+4wDQYJKoZIhvcNAQEL
      BQAwIzEhMB8GA1UEAwwYQXV0b01vYmlsZSBEZWJ1ZyBGaXh0dXJlMCAXDTI2MTEw
      MTExNDUzNFoYDzIxMjYxMDA4MTE0NTM0WjAjMSEwHwYDVQQDDBhBdXRvTW9iaWxl
      IERlYnVnIEZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC8
      +si2zXdC9aS5IaE3orgy+41F6FyRiAljJJGCUXaAmybL35apKQcVtnSLxut0r/Yy
      INfATtCzaCMxGI3nSuC1wF27zVv++sWWtcUkIxOPjlfCVFoExwSDjSPVT4kEs8Ow
      zpLvY8C0g760mtCC3RcB7Y95QJ8qBkDvjdOjPnqUiXaIxtekjSgdot06apRUuZeg
      ZeYvwOBm6V2S3UioqQ5JGo3eAHSycnzb7mksUT4HMVCCtZRmo9FsrWCCfcZaV1nY
      djn5Gl39dQH6qBj8x3nF+5HvHS3pXBMAqSywHYlkqgMNseSUoI6GGlTUiwH3qCCY
      PzqeQnyHKhM3U3GXzqclAgMBAAGjMjAwMB0GA1UdDgQWBBQnIl+wkY8zFYwxE45F
      PmGjAKtX7DAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQC6phXU
      N2Owx/Wm8G4fJQmXMUq42xjlyHWqJGbbfb8SdPFtSArFBYXAKw0WD4cOH96H5J+y
      Q8B5gJbJgcWMSTZ1PAjioE5f5jWjcNR0CkJAK0/KOcm1cyUB9ZZ0epQXt9uKiXbH
      H1gjBjO0133+T4BZ8r/RdFRE+NG5EX6q7+rVSM3mjg9xDvcYrc8NS/lrM9gppBOU
      DcfNcIdue9WCqmn62OokDr81gt/wuTcz7kDyxdwJGSEtblTn+JvS1CjmHIQWdJEc
      fOzgJXgf4wlZsbxypoo5pbd0m8bTbnFKqGyUxeSIGVjMG0ARIMiXs2cNknzUs2tp
      AC9/X92s92zbbfM9
      -----END CERTIFICATE-----
      """
        .trimIndent()
  }
}
