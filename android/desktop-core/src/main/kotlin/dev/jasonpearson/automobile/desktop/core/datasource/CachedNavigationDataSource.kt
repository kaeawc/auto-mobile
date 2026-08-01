package dev.jasonpearson.automobile.desktop.core.datasource

/**
 * Wraps a [NavigationDataSource] with a TTL-based in-memory cache so that repeated calls (e.g., on
 * tab switches or recomposition) return cached data instead of re-fetching.
 */
class CachedNavigationDataSource(
  private val delegate: NavigationDataSource,
  ttlMs: Long = 30_000L,
  clock: () -> Long = System::currentTimeMillis,
) : NavigationDataSource {

  private val cache = InMemoryCache<Unit, Result<NavigationGraph>>(ttlMs, clock)
  // Separate cache keyspace: the apps list is app-independent, so it must not share the graph's
  // Unit key or one would evict/return the other.
  private val appsCache = InMemoryCache<Unit, Result<List<NavigationAppSummary>>>(ttlMs, clock)

  override suspend fun getNavigationGraph(): Result<NavigationGraph> {
    return cache.get(Unit) { delegate.getNavigationGraph() }
  }

  override suspend fun listApps(): Result<List<NavigationAppSummary>> {
    return appsCache.get(Unit) { delegate.listApps() }
  }

  /** Force the next call to re-fetch from the delegate. */
  fun invalidate() {
    cache.invalidate(Unit)
    appsCache.invalidate(Unit)
  }
}
