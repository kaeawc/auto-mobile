package dev.jasonpearson.automobile.desktop.core.datasource

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CachedAppListDataSourceTest {

  private val apps = listOf(InstalledApp("com.example.app", "Example", false))

  /** Counts how many times the delegate is called. */
  private class CountingAppListDataSource(
    private val results: Iterator<Result<List<InstalledApp>>>
  ) : AppListDataSource {
    var callCount = 0

    override suspend fun getInstalledApps(): Result<List<InstalledApp>> {
      callCount++
      return results.next()
    }
  }

  @Test
  fun `returns cached value on second call within TTL`() = runBlocking {
    val delegate =
      CountingAppListDataSource(listOf(Result.Success(apps), Result.Success(apps)).iterator())
    val cached = CachedAppListDataSource(delegate, ttlMs = 1000L)

    cached.getInstalledApps()
    cached.getInstalledApps()

    assertEquals(1, delegate.callCount)
  }

  @Test
  fun `re-fetches after TTL expires`() = runBlocking {
    var now = 0L
    val apps2 = listOf(InstalledApp("com.other", "Other", true))
    val delegate =
      CountingAppListDataSource(listOf(Result.Success(apps), Result.Success(apps2)).iterator())
    val cached = CachedAppListDataSource(delegate, ttlMs = 100L, clock = { now })

    val first = cached.getInstalledApps()
    now = 101L
    val second = cached.getInstalledApps()

    assertEquals(2, delegate.callCount)
    assertTrue(first is Result.Success)
    assertEquals(apps, (first as Result.Success).data)
    assertTrue(second is Result.Success)
    assertEquals(apps2, (second as Result.Success).data)
  }

  @Test
  fun `invalidate forces re-fetch`() = runBlocking {
    val delegate =
      CountingAppListDataSource(listOf(Result.Success(apps), Result.Success(apps)).iterator())
    val cached = CachedAppListDataSource(delegate, ttlMs = 10_000L)

    cached.getInstalledApps()
    cached.invalidate()
    cached.getInstalledApps()

    assertEquals(2, delegate.callCount)
  }
}
