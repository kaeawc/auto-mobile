package dev.jasonpearson.automobile.desktop.core.datasource

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CachedNavigationDataSourceTest {

  private val graph = NavigationGraph(screens = emptyList(), transitions = emptyList())

  /** Counts how many times the delegate is called. */
  private class CountingNavigationDataSource(
    private val results: Iterator<Result<NavigationGraph>>
  ) : NavigationDataSource {
    var callCount = 0

    override suspend fun getNavigationGraph(): Result<NavigationGraph> {
      callCount++
      return results.next()
    }
  }

  @Test
  fun `returns cached value on second call within TTL`() = runBlocking {
    val delegate =
      CountingNavigationDataSource(listOf(Result.Success(graph), Result.Success(graph)).iterator())
    val cached = CachedNavigationDataSource(delegate, ttlMs = 1000L)

    cached.getNavigationGraph()
    cached.getNavigationGraph()

    assertEquals(1, delegate.callCount)
  }

  @Test
  fun `re-fetches after TTL expires`() = runBlocking {
    var now = 0L
    val graph2 = NavigationGraph(screens = emptyList(), transitions = emptyList())
    val delegate =
      CountingNavigationDataSource(listOf(Result.Success(graph), Result.Success(graph2)).iterator())
    val cached = CachedNavigationDataSource(delegate, ttlMs = 100L, clock = { now })

    val first = cached.getNavigationGraph()
    now = 101L
    val second = cached.getNavigationGraph()

    assertEquals(2, delegate.callCount)
    assertTrue(first is Result.Success)
    assertTrue(second is Result.Success)
  }

  @Test
  fun `invalidate forces re-fetch`() = runBlocking {
    val delegate =
      CountingNavigationDataSource(listOf(Result.Success(graph), Result.Success(graph)).iterator())
    val cached = CachedNavigationDataSource(delegate, ttlMs = 10_000L)

    cached.getNavigationGraph()
    cached.invalidate()
    cached.getNavigationGraph()

    assertEquals(2, delegate.callCount)
  }

  @Test
  fun `caches error results too`() = runBlocking {
    val delegate =
      CountingNavigationDataSource(
        listOf(
            Result.Error(RuntimeException("fail")),
            Result.Success(graph),
          )
          .iterator()
      )
    val cached = CachedNavigationDataSource(delegate, ttlMs = 10_000L)

    val first = cached.getNavigationGraph()
    val second = cached.getNavigationGraph()

    assertEquals(1, delegate.callCount)
    assertTrue(first is Result.Error)
    assertTrue(second is Result.Error)
  }
}
