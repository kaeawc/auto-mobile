package dev.jasonpearson.automobile.sdk.storage

import dev.jasonpearson.automobile.sdk.InspectorRegistration
import dev.jasonpearson.automobile.sdk.removeIfIdentical
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException

/**
 * Boundary object for application-provided DataStore inspection.
 *
 * Mirrors the registry pattern of [SharedPreferencesInspector] and
 * [dev.jasonpearson.automobile.sdk.database.DatabaseInspector] but targets DataStore-backed
 * preferences via the read-only [DataStoreAdapter] contract (issue #5192).
 *
 * Responsibilities kept at this boundary — independent of the host adapter:
 * - Lifecycle-safe registration, replacement, and removal of adapters.
 * - Read-only enforcement (the contract exposes no mutation entry point).
 * - Redaction of values via a configurable [DataStoreRedactionPolicy].
 * - Capability reporting via [capabilities].
 *
 * Reads run in the caller's coroutine context, so coroutine cancellation propagates cooperatively
 * and no background coroutines or listeners are retained by this object.
 */
object DataStoreInspector {
  /** Marker substituted for a redacted value. */
  const val REDACTED_VALUE: String = "[redacted]"

  private val adapters = ConcurrentHashMap<String, DataStoreAdapter>()
  @Volatile private var redactionPolicy: DataStoreRedactionPolicy = DataStoreRedactionPolicy.NONE

  /**
   * Registers or replaces the application-provided adapter under [name].
   *
   * Returns an [InspectorRegistration] whose [InspectorRegistration.unregister] removes this
   * adapter only if it has not since been replaced under the same name (issue #5581).
   */
  fun registerAdapter(name: String, adapter: DataStoreAdapter): InspectorRegistration {
    require(name.isNotBlank()) { "adapter name must not be blank" }
    adapters[name] = adapter
    return InspectorRegistration { adapters.removeIfIdentical(name, adapter) }
  }

  /** Removes the adapter registered under [name] and returns whether one was registered. */
  fun unregisterAdapter(name: String): Boolean = adapters.remove(name) != null

  /** Returns the names of all registered adapters. */
  fun registeredAdapterNames(): Set<String> = adapters.keys.toSet()

  /** Installs the boundary redaction policy applied to every value read. */
  fun setRedactionPolicy(policy: DataStoreRedactionPolicy) {
    redactionPolicy = policy
  }

  /** Returns the names of the DataStore instances exposed by adapter [adapterName]. */
  suspend fun storeNames(adapterName: String): List<String> {
    val adapter = resolve(adapterName)
    return runAdapterRead { adapter.storeNames() }
  }

  /**
   * Describes the DataStore instances exposed by adapter [adapterName], including entry counts and
   * without exposing any filesystem path (issue #5192).
   */
  suspend fun describeStores(adapterName: String): List<DataStoreDescriptor> {
    val adapter = resolve(adapterName)
    val names = runAdapterRead { adapter.storeNames() }
    return names.mapNotNull { name ->
      try {
        val entries = runAdapterRead { adapter.read(name) }
        DataStoreDescriptor(name = name, entryCount = entries.size)
      } catch (_: DataStoreAdapterError.StoreNotFound) {
        // A store removed between storeNames() and its read() is simply omitted from the
        // listing rather than failing the whole call (issue #5192). Other read failures still
        // propagate so a genuinely broken adapter is not silently hidden.
        null
      }
    }
  }

  /**
   * Reads [storeName] from adapter [adapterName], applying the configured redaction policy at the
   * boundary.
   */
  suspend fun readStore(adapterName: String, storeName: String): List<DataStoreEntry> {
    val adapter = resolve(adapterName)
    val entries = runAdapterRead { adapter.read(storeName) }
    // Capture the redaction policy AFTER the (suspending) read so a policy tightened concurrently
    // while the read was suspended is honored rather than bypassed (issue #5192 review). Snapshot
    // once into a local so it applies uniformly across every entry (no partial application).
    val policy = redactionPolicy
    return entries.map { entry ->
      if (policy.shouldRedact(storeName, entry.key)) {
        // Redact to a STRING marker rather than keeping the original type: a redacted
        // STRING_SET/BYTE_ARRAY whose value is the marker string would otherwise serialize to
        // null downstream and be indistinguishable from an absent value (issue #5192 review).
        entry.copy(value = REDACTED_VALUE, type = DataStoreValueType.STRING)
      } else {
        entry
      }
    }
  }

  /** Reports the capabilities of the DataStore integration at the AutoMobile boundary. */
  fun capabilities(): DataStoreCapabilities =
    DataStoreCapabilities(
      readSupported = adapters.isNotEmpty(),
      redactionEnabled = redactionPolicy !== DataStoreRedactionPolicy.NONE,
    )

  /** Clears all registered adapters and resets policy. Wired into SDK shutdown. */
  internal fun reset() {
    adapters.clear()
    redactionPolicy = DataStoreRedactionPolicy.NONE
  }

  private fun resolve(adapterName: String): DataStoreAdapter =
    adapters[adapterName] ?: throw DataStoreAdapterError.AdapterNotFound(adapterName)

  /**
   * Runs a host adapter read, letting structured [DataStoreAdapterError]s and coroutine
   * cancellation propagate unchanged while wrapping any other host failure as a structured
   * [DataStoreAdapterError.ReadError].
   */
  private inline fun <T> runAdapterRead(block: () -> T): T =
    try {
      block()
    } catch (e: DataStoreAdapterError) {
      throw e
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      // Catch Exception, not Throwable: a JVM-fatal Error (OutOfMemoryError, LinkageError,
      // ThreadDeath) must propagate rather than be rewrapped as an ordinary ReadError.
      // CancellationException is an Exception but is handled by its explicit branch above.
      throw DataStoreAdapterError.ReadError(e.message ?: e::class.simpleName ?: "unknown", e)
    }
}
