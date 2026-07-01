package dev.jasonpearson.automobile.desktop.core.datasource

/**
 * Wraps an [AppListDataSource] with a TTL-based in-memory cache so that repeated calls (e.g., on
 * tab switches or recomposition) return cached data instead of re-fetching.
 */
class CachedAppListDataSource(
    private val delegate: AppListDataSource,
    ttlMs: Long = 30_000L,
    clock: () -> Long = System::currentTimeMillis,
) : AppListDataSource {

  private val cache = InMemoryCache<Unit, Result<List<InstalledApp>>>(ttlMs, clock)

  override suspend fun getInstalledApps(): Result<List<InstalledApp>> {
    return cache.get(Unit) { delegate.getInstalledApps() }
  }

  /** Force the next call to re-fetch from the delegate. */
  fun invalidate() {
    cache.invalidate(Unit)
  }
}
