package dev.jasonpearson.automobile.sdk.storage

/** Structured errors surfaced by the DataStore inspection boundary. */
sealed class DataStoreAdapterError(message: String) : Exception(message) {
  /** No application-provided adapter was registered under the requested name. */
  class AdapterNotFound(name: String) : DataStoreAdapterError("DataStore adapter not found: $name")

  /** The adapter does not expose a DataStore instance with the requested name. */
  class StoreNotFound(name: String) : DataStoreAdapterError("DataStore not found: $name")

  /** A read failed inside the host adapter. */
  class ReadError(reason: String, cause: Throwable? = null) :
    DataStoreAdapterError("DataStore read error: $reason") {
    init {
      if (cause != null) initCause(cause)
    }
  }

  /** A value could not be represented by the contract's supported types. */
  class UnsupportedValue(storeName: String, key: String, valueType: String) :
    DataStoreAdapterError(
      "Unsupported DataStore value for $storeName/$key: $valueType is not representable"
    )
}
