package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.UserNotAuthenticatedException
import java.security.KeyStoreException
import java.security.ProviderException

internal fun interface KeystoreSleeper {
  fun sleep(delayMs: Long)
}

/**
 * Upper bound on injected DELAY for one provider call, summed across every selected alias and
 * backend operation. It equals the largest single delay, so one call never waits longer than one
 * maximal fault and the host's Keystore reset timeout can cover it (#17291).
 */
internal const val MAX_INJECTED_DELAY_PER_CALL_MS = 10_000L

/** Spends at most [MAX_INJECTED_DELAY_PER_CALL_MS] in total; delays past the budget are skipped. */
internal class KeystoreDelayBudget(private val sleeper: KeystoreSleeper) {
  private var remainingMs = MAX_INJECTED_DELAY_PER_CALL_MS

  fun sleep(delayMs: Long) {
    val granted = minOf(delayMs, remainingMs)
    if (granted <= 0L) return
    remainingMs -= granted
    sleeper.sleep(granted)
  }
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
    val delayValid = delayMs != null && delayMs in 1L..MAX_INJECTED_DELAY_PER_CALL_MS
    if (parsed == Kind.DELAY && !delayValid) return false
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
    // Most calls hit an empty plan; skip the declared-scope scan unless a fault is armed.
    val fault = faults[alias] ?: return null
    if (!isDeclared(alias)) {
      faults.remove(alias)
      return null
    }
    return fault
  }

  fun apply(alias: String, budget: KeystoreDelayBudget) {
    val fault = faultFor(alias) ?: return
    // Never hold the process-wide plan monitor while sleeping or accessing the backend.
    when (fault.kind) {
      Kind.KEY_STORE_EXCEPTION -> throw KeyStoreException()
      Kind.PROVIDER_EXCEPTION -> throw ProviderException()
      Kind.USER_NOT_AUTHENTICATED -> throw UserNotAuthenticatedException()
      Kind.DELAY -> budget.sleep(requireNotNull(fault.delayMs))
    }
  }
}

/** Construct one per provider call: its delay budget bounds that call's total injected delay. */
internal class FaultingKeystoreBackend(
  private val backend: KeystoreBackend,
  sleeper: KeystoreSleeper = KeystoreSleeper { Thread.sleep(it) },
) : KeystoreBackend {
  private val budget = KeystoreDelayBudget(sleeper)

  override fun containsAlias(alias: String): Boolean {
    KeystoreFaultPlan.apply(alias, budget)
    return backend.containsAlias(alias)
  }

  override fun entryCategory(alias: String): EntryCategory {
    KeystoreFaultPlan.apply(alias, budget)
    return backend.entryCategory(alias)
  }

  override fun deleteAlias(alias: String) {
    KeystoreFaultPlan.apply(alias, budget)
    backend.deleteAlias(alias)
  }
}
