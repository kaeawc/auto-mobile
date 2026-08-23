package dev.jasonpearson.automobile.sdk.storage

import kotlinx.coroutines.CompletableDeferred

/**
 * Deterministic reference/fake implementation of [DataStoreAdapter] for tests.
 *
 * Backed by in-memory maps keyed by store name. Value kinds map onto [DataStoreValueType] the same
 * way a real preferences DataStore adapter would; an unrepresentable value surfaces as
 * [DataStoreValueType.UNKNOWN] unless [rejectUnsupported] is set, in which case the adapter throws
 * [DataStoreAdapterError.UnsupportedValue].
 */
class FakeDataStoreAdapter : DataStoreAdapter {
  private val stores = linkedMapOf<String, MutableMap<String, Any?>>()

  /** When true, an unrepresentable value throws instead of mapping to UNKNOWN. */
  var rejectUnsupported: Boolean = false

  /**
   * Optional gate a test can await to hold [read] suspended, so cancellation can be exercised
   * deterministically. When set, [read] awaits it before returning.
   */
  var readGate: CompletableDeferred<Unit>? = null

  /** Seeds a store with entries, replacing any existing contents. */
  fun setStore(storeName: String, data: Map<String, Any?>) {
    stores[storeName] = data.toMutableMap()
  }

  override suspend fun storeNames(): List<String> = stores.keys.toList()

  override suspend fun read(storeName: String): List<DataStoreEntry> {
    val data = stores[storeName] ?: throw DataStoreAdapterError.StoreNotFound(storeName)
    readGate?.await()
    return data.map { (key, value) ->
      val type = detectType(value)
      if (type == DataStoreValueType.UNKNOWN && value != null && rejectUnsupported) {
        throw DataStoreAdapterError.UnsupportedValue(
          storeName,
          key,
          value::class.simpleName ?: "unknown",
        )
      }
      DataStoreEntry(key = key, value = value, type = type)
    }
  }

  private fun detectType(value: Any?): DataStoreValueType =
    when (value) {
      null -> DataStoreValueType.UNKNOWN
      is String -> DataStoreValueType.STRING
      is Int -> DataStoreValueType.INT
      is Long -> DataStoreValueType.LONG
      is Float -> DataStoreValueType.FLOAT
      is Double -> DataStoreValueType.DOUBLE
      is Boolean -> DataStoreValueType.BOOLEAN
      is ByteArray -> DataStoreValueType.BYTE_ARRAY
      is Set<*> -> DataStoreValueType.STRING_SET
      else -> DataStoreValueType.UNKNOWN
    }
}
