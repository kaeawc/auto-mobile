package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.datasource.InstalledApp
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationMockData
import dev.jasonpearson.automobile.desktop.core.shell.SearchCategory
import dev.jasonpearson.automobile.desktop.core.shell.SearchResult
import dev.jasonpearson.automobile.desktop.core.shell.SearchResultProvider
import dev.jasonpearson.automobile.desktop.core.telemetry.TelemetryDisplayEvent
import dev.jasonpearson.automobile.desktop.core.telemetry.matchesSearch

internal class AutoMobileSearchProvider(
  private val events: () -> List<TelemetryDisplayEvent>,
  private val apps: () -> List<InstalledApp>,
  private val onAppSelected: (String) -> Unit,
) : SearchResultProvider {
  override fun search(query: String): List<SearchResult> {
    if (query.isBlank()) return emptyList()
    val results = mutableListOf<SearchResult>()
    searchTelemetry(query, results)
    searchNavigation(query, results)
    searchApps(query, results)
    return results
  }

  private fun searchTelemetry(query: String, results: MutableList<SearchResult>) {
    // Telemetry events (most recent 200, capped for performance)
    events()
      .takeLast(200)
      .filter { it.matchesSearch(query) }
      .take(20)
      .forEachIndexed { i, event ->
        val (label, preview) =
          when (event) {
            is TelemetryDisplayEvent.Network ->
              "${event.method} ${event.url}" to "${event.statusCode}"
            is TelemetryDisplayEvent.Log -> "[${event.tag}] ${event.message.take(40)}" to event.tag
            is TelemetryDisplayEvent.Navigation -> event.destination to (event.source ?: "")
            is TelemetryDisplayEvent.Failure -> event.title to event.type
            else -> (event::class.simpleName ?: "Event") to ""
          }
        results.add(
          SearchResult(
            id = "tel_${i}_${event.timestamp}",
            category = SearchCategory.TelemetryEvent,
            label = label,
            preview = preview,
            onSelect = {},
          ),
        )
      }
  }

  private fun searchNavigation(query: String, results: MutableList<SearchResult>) {
    // Navigation screens from mock data
    NavigationMockData.screens
      .filter {
        it.name.contains(query, ignoreCase = true) ||
          it.packageName.contains(query, ignoreCase = true)
      }
      .take(10)
      .forEach { screen ->
        results.add(
          SearchResult(
            id = "nav_${screen.id}",
            category = SearchCategory.NavigationScreen,
            label = screen.name,
            preview = "${screen.type} · ${screen.packageName}",
            onSelect = {},
          ),
        )
      }
  }

  private fun searchApps(query: String, results: MutableList<SearchResult>) {
    // Installed apps as hierarchy elements
    apps()
      .filter { it.packageName.contains(query, ignoreCase = true) }
      .take(10)
      .forEach { app ->
        results.add(
          SearchResult(
            id = "app_${app.packageName}",
            category = SearchCategory.HierarchyElement,
            label = app.packageName.substringAfterLast('.'),
            preview = app.packageName,
            onSelect = { onAppSelected(app.packageName) },
          ),
        )
      }
  }
}
