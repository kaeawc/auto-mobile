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

  override suspend fun getNavigationGraph(): Result<NavigationGraph> {
    return cache.get(Unit) { delegate.getNavigationGraph() }
  }

  /** Force the next call to re-fetch from the delegate. */
  fun invalidate() {
    cache.invalidate(Unit)
  }
}
