package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.navigation.NavigationMockData
import kotlinx.coroutines.delay

/** Fake navigation data source returning mock data for UI development. */
class FakeNavigationDataSource : NavigationDataSource {
  override suspend fun getNavigationGraph(): Result<NavigationGraph> {
    // Simulate network delay
    delay(100)

    return Result.Success(
      NavigationGraph(
        screens = NavigationMockData.screens,
        transitions = NavigationMockData.transitions,
      )
    )
  }

  override suspend fun listApps(): Result<List<NavigationAppSummary>> {
    delay(100)
    // Newest-first, mirroring the daemon's ordering; one entry has a null displayName so UI
    // development exercises the appId fallback.
    return Result.Success(
      listOf(
        NavigationAppSummary(
          appId = "com.example.shopping",
          displayName = "Shopping",
          lastUpdated = "2026-01-03T12:00:00.000Z",
        ),
        NavigationAppSummary(
          appId = "com.example.banking",
          displayName = null,
          lastUpdated = "2026-01-01T09:30:00.000Z",
        ),
      )
    )
  }
}
