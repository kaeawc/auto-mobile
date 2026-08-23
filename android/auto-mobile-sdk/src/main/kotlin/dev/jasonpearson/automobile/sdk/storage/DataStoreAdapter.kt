package dev.jasonpearson.automobile.sdk.storage

/**
 * Application-provided adapter that exposes DataStore-backed preferences to AutoMobile for
 * inspection.
 *
 * The host application implements this interface against its own DataStore instances — typically
 * `androidx.datastore.core.DataStore<androidx.datastore.preferences.core.Preferences>` — and
 * registers it with [DataStoreInspector.registerAdapter]. AutoMobile never links against
 * `androidx.datastore`; the adapter is the sole integration point, which keeps the host free to
 * choose its DataStore version and layout.
 *
 * Contract rules:
 * - **Read-only.** The interface exposes no mutation entry point. Read-only enforcement therefore
 *   lives at the AutoMobile boundary and does not depend on the host honoring a flag.
 * - **No filesystem paths.** Stores are identified by stable, application-chosen names; the host
 *   must never surface `preferencesDataStoreFile` paths.
 * - **Structured values only.** Values should map onto [DataStoreValueType]. A value whose runtime
 *   kind is not representable should be surfaced as [DataStoreValueType.UNKNOWN] (or the adapter
 *   may throw [DataStoreAdapterError.UnsupportedValue] to reject it).
 * - **Suspend, cooperative cancellation.** Reads are `suspend` and must honor coroutine
 *   cancellation. Implementations must not launch unscoped coroutines or leak listeners; any
 *   collection should complete within the calling coroutine.
 */
interface DataStoreAdapter {
  /** Returns the stable names of the DataStore instances this adapter exposes. */
  suspend fun storeNames(): List<String>

  /**
   * Returns a structured snapshot of every entry in [storeName].
   *
   * @throws DataStoreAdapterError.StoreNotFound if the adapter does not expose [storeName]
   * @throws DataStoreAdapterError.UnsupportedValue if a value cannot be represented and the adapter
   *   chooses to reject rather than mark it [DataStoreValueType.UNKNOWN]
   */
  suspend fun read(storeName: String): List<DataStoreEntry>
}
