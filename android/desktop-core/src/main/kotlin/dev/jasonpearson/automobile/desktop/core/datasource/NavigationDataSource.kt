package dev.jasonpearson.automobile.desktop.core.datasource

typealias NavigationGraph = dev.jasonpearson.automobile.desktop.domain.NavigationGraph

interface NavigationDataSource {
  suspend fun getNavigationGraph(): Result<NavigationGraph>
}
