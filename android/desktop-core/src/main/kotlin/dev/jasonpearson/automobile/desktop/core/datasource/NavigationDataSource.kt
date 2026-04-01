package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.navigation.ScreenNode
import dev.jasonpearson.automobile.desktop.core.navigation.ScreenTransition

data class NavigationGraph(
    val screens: List<ScreenNode>,
    val transitions: List<ScreenTransition>,
)

interface NavigationDataSource {
    suspend fun getNavigationGraph(): Result<NavigationGraph>
}
