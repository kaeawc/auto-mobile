package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.UserNotAuthenticatedException
import java.security.KeyStoreException
import java.security.ProviderException

internal fun interface KeystoreSleeper {
  fun sleep(delayMs: Long)
}

/** Process-wide debug faults, restricted to exact currently declared aliases. */
internal object KeystoreFaultPlan {
  private enum class Kind {
    KEY_STORE_EXCEPTION,
    PROVIDER_EXCEPTION,
    USER_NOT_AUTHENTICATED,
    DELAY,
  }

  private data class Fault(val kind: Kind, val delayMs: Long?)

  private val faults = mutableMapOf<String, Fault>()

  /** Validate the whole selection before replacing any existing faults. */
  @Synchronized
  fun inject(aliases: List<String>, kind: String?, delayMs: Long?): Boolean {
    clearIfDisabled()
    if (!KeystoreTestState.isEnabled()) return false
    val parsed = Kind.entries.firstOrNull { it.name == kind } ?: return false
    if (parsed == Kind.DELAY && (delayMs == null || delayMs !in 1L..10_000L)) return false
    if (aliases.isEmpty() || aliases.any { !isDeclared(it) }) return false
    val fault = Fault(parsed, if (parsed == Kind.DELAY) delayMs else null)
    aliases.forEach { faults[it] = fault }
    return true
  }

  @Synchronized
  fun clear(aliases: List<String>) {
    clearIfDisabled()
    aliases.forEach { faults.remove(it) }
  }

  @Synchronized
  fun clearAll() {
    faults.clear()
  }

  // No main-source lifecycle hook: discard the plan whenever disabled/reset state is observed.
  @Synchronized
  fun clearIfDisabled() {
    if (!KeystoreTestState.isEnabled()) faults.clear()
  }

  private fun isDeclared(alias: String): Boolean =
    KeystoreTestState.declaredScopes().any {
      alias in KeystoreTestState.aliasesForScope(it).orEmpty()
    }

  @Synchronized
  private fun faultFor(alias: String): Fault? {
    clearIfDisabled()
    if (!KeystoreTestState.isEnabled()) return null
    if (!isDeclared(alias)) {
      faults.remove(alias)
      return null
    }
    return faults[alias]
  }

  fun apply(alias: String, sleeper: KeystoreSleeper) {
    val fault = faultFor(alias) ?: return
    // Never hold the process-wide plan monitor while sleeping or accessing the backend.
    when (fault.kind) {
      Kind.KEY_STORE_EXCEPTION -> throw KeyStoreException()
      Kind.PROVIDER_EXCEPTION -> throw ProviderException()
      Kind.USER_NOT_AUTHENTICATED -> throw UserNotAuthenticatedException()
      Kind.DELAY -> sleeper.sleep(requireNotNull(fault.delayMs))
    }
  }
}

internal class FaultingKeystoreBackend(
  private val backend: KeystoreBackend,
  private val sleeper: KeystoreSleeper = KeystoreSleeper { Thread.sleep(it) },
) : KeystoreBackend {
  override fun containsAlias(alias: String): Boolean {
    KeystoreFaultPlan.apply(alias, sleeper)
    return backend.containsAlias(alias)
  }

  override fun entryCategory(alias: String): EntryCategory {
    KeystoreFaultPlan.apply(alias, sleeper)
    return backend.entryCategory(alias)
  }

  override fun deleteAlias(alias: String) {
    KeystoreFaultPlan.apply(alias, sleeper)
    backend.deleteAlias(alias)
  }
}
