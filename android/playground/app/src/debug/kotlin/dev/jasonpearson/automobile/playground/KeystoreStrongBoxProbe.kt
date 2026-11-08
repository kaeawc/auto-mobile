package dev.jasonpearson.automobile.playground

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.annotation.RequiresApi
import dev.jasonpearson.automobile.sdk.keystore.KeystoreTestState
import javax.crypto.KeyGenerator

/** Two steps of one AndroidKeyStore key generation, split so the probe can tell them apart. */
internal interface StrongBoxKeyGenerator {
  /** Runs the debug SDK key-generation gate for the spec that [generate] would use. */
  fun checkGeneration(alias: String, strongBox: Boolean)

  fun generate(alias: String, strongBox: Boolean)
}

/**
 * Generates [ALIAS] with StrongBox requested and falls back to a non-StrongBox key the way an app
 * would. The outcome separates an injected STRONGBOX_UNAVAILABLE fault (thrown by the SDK gate)
 * from real hardware without StrongBox (thrown by key generation itself), so a manual test can
 * confirm the fault on an emulator that also lacks StrongBox.
 */
internal class KeystoreStrongBoxProbe(
  private val generator: StrongBoxKeyGenerator,
  private val isStrongBoxUnavailable: (Throwable) -> Boolean,
) {
  fun run(): String {
    val injected = runCatching { generator.checkGeneration(ALIAS, strongBox = true) }
    val failure =
      injected.exceptionOrNull()
        ?: runCatching { generator.generate(ALIAS, strongBox = true) }.exceptionOrNull()
        ?: return STRONGBOX
    val fallbackOutcome = if (injected.isFailure) FALLBACK_INJECTED else FALLBACK_HARDWARE
    return if (isStrongBoxUnavailable(failure)) fallBack(fallbackOutcome)
    else "error:${failure.javaClass.simpleName}"
  }

  private fun fallBack(outcome: String): String {
    val error = runCatching {
      generator.checkGeneration(ALIAS, strongBox = false)
      generator.generate(ALIAS, strongBox = false)
    }
      .exceptionOrNull()
    return if (error == null) outcome else "error:fallback:${error.javaClass.simpleName}"
  }

  companion object {
    const val ALIAS = "automobile.fixture.strongbox"
    const val STRONGBOX = "strongbox"
    const val FALLBACK_INJECTED = "fallback:injected"
    const val FALLBACK_HARDWARE = "fallback:hardware"
    const val UNSUPPORTED = "unsupported"
  }
}

@RequiresApi(Build.VERSION_CODES.P)
internal class AndroidStrongBoxKeyGenerator : StrongBoxKeyGenerator {
  override fun checkGeneration(alias: String, strongBox: Boolean) {
    KeystoreTestState.checkKeyGeneration(spec(alias, strongBox))
  }

  override fun generate(alias: String, strongBox: Boolean) {
    require(alias == KeystoreStrongBoxProbe.ALIAS)
    KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(spec(alias, strongBox))
      generateKey()
    }
  }

  private fun spec(alias: String, strongBox: Boolean): KeyGenParameterSpec =
    KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setUserAuthenticationRequired(false)
      .setIsStrongBoxBacked(strongBox)
      .build()
}
