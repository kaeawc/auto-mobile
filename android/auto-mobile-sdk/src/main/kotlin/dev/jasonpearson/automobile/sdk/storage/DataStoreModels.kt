package dev.jasonpearson.automobile.sdk.storage

/**
 * Describes a named DataStore instance exposed by a [DataStoreAdapter].
 *
 * Deliberately carries **no filesystem path**: the AutoMobile DataStore integration identifies
 * stores by a stable, application-chosen name so that host applications never have to expose
 * `preferencesDataStoreFile` paths or other private data-directory locations (issue #5192).
 */
data class DataStoreDescriptor(
  /** Stable, application-chosen name of the DataStore instance. */
  val name: String,
  /** Number of key-value entries currently held by the store. */
  val entryCount: Int,
)

/** A single structured key-value entry read from a DataStore instance. */
data class DataStoreEntry(
  /** The preference key. */
  val key: String,
  /**
   * The preference value, or null when the key is absent. A value removed by the configured
   * redaction policy is replaced with the [DataStoreInspector.REDACTED_VALUE] marker string and its
   * [type] is set to [DataStoreValueType.STRING] (so the marker survives wire serialization) —
   * redaction never yields null. Callers should interpret the value through [type]; an
   * [DataStoreValueType.UNKNOWN] type marks a value whose runtime kind is not representable by the
   * contract.
   */
  val value: Any?,
  /** The structured type of [value]. */
  val type: DataStoreValueType,
)

/**
 * The value kinds representable by the DataStore adapter contract.
 *
 * Mirrors the types supported by `androidx.datastore.preferences.core.Preferences` (String, Int,
 * Long, Float, Double, Boolean, `Set<String>`, and byte arrays). [UNKNOWN] is a structured
 * representation for a value whose runtime kind is not one of the supported types, so an
 * unsupported value is surfaced explicitly rather than silently dropped.
 */
enum class DataStoreValueType {
  STRING,
  INT,
  LONG,
  FLOAT,
  DOUBLE,
  BOOLEAN,
  STRING_SET,
  BYTE_ARRAY,
  UNKNOWN,
}

/**
 * Boundary-side policy deciding whether an entry's value must be redacted before it leaves the SDK.
 *
 * Enforced by [DataStoreInspector] independently of the host adapter, so a host implementation
 * cannot opt out of the configured redaction policy.
 */
fun interface DataStoreRedactionPolicy {
  /** Returns true when the value for [key] in [storeName] must be redacted. */
  fun shouldRedact(storeName: String, key: String): Boolean

  companion object {
    /** A policy that never redacts. */
    val NONE: DataStoreRedactionPolicy = DataStoreRedactionPolicy { _, _ -> false }
  }
}

/**
 * Machine-readable report of what the DataStore integration can do at the AutoMobile boundary.
 *
 * Reported independently of any host adapter so a client can reason about the contract even before
 * an adapter is registered (issue #5192).
 */
data class DataStoreCapabilities(
  /**
   * Whether at least one application-provided adapter is currently registered. This reflects
   * registration only — it does not verify that an adapter can successfully list or read a store.
   */
  val readSupported: Boolean,
  /**
   * Always false: the DataStore adapter contract is read-only and exposes no mutation entry point,
   * so mutation is unsupported at the AutoMobile boundary regardless of the host implementation.
   */
  val mutationSupported: Boolean = false,
  /** Whether a non-[DataStoreRedactionPolicy.NONE] redaction policy is currently configured. */
  val redactionEnabled: Boolean,
  /** The value types the contract can represent. */
  val supportedValueTypes: List<DataStoreValueType> =
    DataStoreValueType.entries.filter { it != DataStoreValueType.UNKNOWN },
)
