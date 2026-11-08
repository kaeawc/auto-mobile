package dev.jasonpearson.automobile.sdk.keystore

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import dev.jasonpearson.automobile.sdk.InspectorRegistration
import dev.jasonpearson.automobile.sdk.removeIfIdentical
import java.util.concurrent.ConcurrentHashMap

/**
 * Code-only opt-in for debug/test metadata and scoped deletion in the app's security context. Exact
 * declared aliases only; grants no cross-application access and never returns key material. The
 * provider is absent from release builds. Package-data reset is a separate operation.
 *
 * Metadata present=false means not present or not observable: AndroidKeyStore hides lookup
 * failures. Real entries report KEY, CERTIFICATE, or UNKNOWN using isKeyEntry/isCertificateEntry
 * without loading certificates; SECRET_KEY/PRIVATE_KEY remain reserved. deviceLocked=locked comes
 * from the injected device lock probe. Per-alias locked/authentication_required outcomes are
 * reserved and cannot be observed by the current real-device read-only metadata path.
 */
object KeystoreTestState {
  @Volatile private var enabled = false
  private val scopes = ConcurrentHashMap<String, Set<String>>()

  /** Installed only by the debug fault plan; release builds keep it null (#17300). */
  @Volatile internal var keyGenerationGate: KeyGenerationGate? = null

  /**
   * Call immediately before generating a key from [spec] with KeyGenerator or KeyPairGenerator.
   * When the debug SDK has a STRONGBOX_UNAVAILABLE fault armed for the spec's declared alias and
   * [spec] requests StrongBox, this throws StrongBoxUnavailableException, as key generation does on
   * a device without StrongBox. A no-op in release builds, below API 28, and with no fault armed.
   */
  fun checkKeyGeneration(spec: KeyGenParameterSpec) {
    val gate = keyGenerationGate ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
    gate.check(spec.keystoreAlias, spec.isStrongBoxBacked)
  }

  fun setEnabled(value: Boolean) {
    enabled = value
  }

  fun isEnabled(): Boolean = enabled

  /** A replacement is protected from stale owners calling InspectorRegistration.unregister(). */
  fun declareScope(name: String, aliases: Set<String>): InspectorRegistration {
    require(name.isNotBlank()) { "scope name must not be blank" }
    require(aliases.isNotEmpty() && aliases.all { it.isNotBlank() }) {
      "scope must declare nonblank aliases"
    }
    val snapshot = aliases.toMutableSet()
    scopes[name] = snapshot
    return InspectorRegistration { scopes.removeIfIdentical(name, snapshot) }
  }

  internal fun declaredScopes(): Set<String> = scopes.keys.toSet()

  internal fun aliasesForScope(name: String): Set<String>? = scopes[name]?.toSet()

  internal fun reset() {
    enabled = false
    scopes.clear()
  }
}

internal fun interface KeyGenerationGate {
  fun check(alias: String, strongBoxRequested: Boolean)
}
