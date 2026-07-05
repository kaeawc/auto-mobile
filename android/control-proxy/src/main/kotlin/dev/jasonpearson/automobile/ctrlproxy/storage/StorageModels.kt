package dev.jasonpearson.automobile.ctrlproxy.storage

import kotlinx.serialization.Serializable

/** Represents an active subscription to SharedPreferences file changes. */
@Serializable
data class StorageSubscription(
  val packageName: String,
  val fileName: String,
  val subscriptionId: String = "$packageName:$fileName",
) {
  companion object {
    /**
     * Inverts the [subscriptionId] format back into its `(packageName, fileName)` parts. This is
     * the single canonical parse for the `"$packageName:$fileName"` format built above — both the
     * inbound `unsubscribe_storage` dispatch (which receives only a subscriptionId from the TS
     * client) and [StorageSubscriptionManager.destroy] resolve ids through here, so the format
     * lives in one place.
     *
     * Package names never contain `:`, so the FIRST `:` delimits packageName from fileName (a file
     * name could theoretically contain `:`). Returns null when [subscriptionId] has no `:` or an
     * empty package/file segment — i.e. it could not have been produced by a real subscription.
     */
    fun parseId(subscriptionId: String): Pair<String, String>? {
      val separator = subscriptionId.indexOf(':')
      if (separator <= 0 || separator >= subscriptionId.length - 1) return null
      return subscriptionId.substring(0, separator) to subscriptionId.substring(separator + 1)
    }
  }
}

/** Information about a SharedPreferences file. */
@Serializable
data class PreferenceFileInfo(
  val name: String,
  val path: String,
  val entryCount: Int,
)

/** A key-value entry from SharedPreferences. */
@Serializable
data class PreferenceEntry(
  val key: String,
  /** JSON-encoded value (null if the value itself is null). */
  val value: String?,
  /** Type name matching SDK KeyValueType enum. */
  val type: String,
)

/** A change event for a preference value. */
@Serializable
data class PreferenceChangeEvent(
  val packageName: String,
  val fileName: String,
  /** The key that changed, or null if the file was cleared. */
  val key: String?,
  /** JSON-encoded new value (null if key was removed). */
  val value: String?,
  /** Type name matching SDK KeyValueType enum. */
  val type: String,
  /** Timestamp when the change occurred (milliseconds since epoch). */
  val timestamp: Long,
  /** Monotonically increasing sequence number for ordering changes. */
  val sequenceNumber: Long,
  /**
   * JSON-encoded value BEFORE the change (null if there was no prior value). Threaded from the SDK
   * so the TS telemetry ingest can skip its per-insert previous-value lookup (#3000). Defaults to
   * null for older SDKs.
   */
  val previousValue: String? = null,
  /**
   * Type name of [previousValue], which may differ from [type] on a remove or type-changing write.
   * The wire encoder quotes [previousValue] by THIS type so it stays valid JSON even when [type] is
   * UNKNOWN (#3000). Null for older SDKs / no prior value.
   */
  val previousValueType: String? = null,
)
