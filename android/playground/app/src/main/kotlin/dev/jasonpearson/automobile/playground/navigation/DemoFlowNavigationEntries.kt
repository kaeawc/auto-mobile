package dev.jasonpearson.automobile.playground.navigation

import android.util.Log
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.jasonpearson.automobile.demos.DemoIndexNavigation
import dev.jasonpearson.automobile.demos.DemoIndexScreen
import dev.jasonpearson.automobile.demos.PerformanceDetailScreen
import dev.jasonpearson.automobile.demos.PerformanceListScreen
import dev.jasonpearson.automobile.demos.StartupDemoScreen
import dev.jasonpearson.automobile.demos.UxFlowDetailsScreen
import dev.jasonpearson.automobile.demos.UxFlowStartScreen
import dev.jasonpearson.automobile.demos.UxFlowSummaryScreen
import dev.jasonpearson.automobile.design.system.demo.DesignSystemDemoScreen
import dev.jasonpearson.automobile.sdk.adapters.Navigation3Adapter

private const val TAG = "AppNavigation"

internal fun EntryProviderScope<NavKey>.demoFlowNavigationEntries(state: NavigationState) {
  entry<DemoIndexDestination> { destination -> DemoIndexEntry(destination, state) }
  entry<DesignSystemDemoDestination> { destination -> DesignSystemDemoEntry(destination, state) }
  entry<DemoUxStartDestination> { destination -> DemoUxStartEntry(destination, state) }
  entry<DemoUxDetailsDestination> { destination -> DemoUxDetailsEntry(destination, state) }
  entry<DemoUxSummaryDestination> { destination -> DemoUxSummaryEntry(destination, state) }
  entry<DemoStartupDestination> { destination -> DemoStartupEntry(destination, state) }
  entry<DemoPerformanceListDestination> { destination ->
    DemoPerformanceListEntry(destination, state)
  }
  entry<DemoPerformanceDetailDestination> { destination ->
    DemoPerformanceDetailEntry(destination, state)
  }
}

@Composable
private fun DemoIndexEntry(destination: DemoIndexDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to DemoIndexScreen")
    analyticsTracker.trackScreenView("DemoIndexScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoIndexDestination>()) {
    DemoIndexScreen(
      navigation =
        DemoIndexNavigation(
          onNavigateToUxFlow = { backStack.add(DemoUxStartDestination) },
          onNavigateToStartup = { backStack.add(DemoStartupDestination) },
          onNavigateToPerformanceList = { backStack.add(DemoPerformanceListDestination) },
          onNavigateToContrast = { backStack.add(DemoContrastDestination) },
          onNavigateToTapTargets = { backStack.add(DemoTapTargetsDestination) },
          onNavigateToXmlSemanticLinks = { backStack.add(DemoXmlSemanticLinksDestination) },
          onNavigateToComposeSemanticLinks = { backStack.add(DemoComposeSemanticLinksDestination) },
          onNavigateToNestedSelection = { backStack.add(DemoNestedSelectionDestination) },
          onNavigateToBugRepro = { backStack.add(DemoBugReproDestination) },
          onNavigateToHandledException = { backStack.add(DemoHandledExceptionDestination) },
          onNavigateToNetworkTest = { backStack.add(DemoNetworkTestDestination) },
          onNavigateToPointerProbe = { backStack.add(DemoPointerProbeDestination) },
          onNavigateToDesignSystem = { backStack.add(DesignSystemDemoDestination) },
          onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
        ),
    )
  }
}

@Composable
private fun DesignSystemDemoEntry(
  destination: DesignSystemDemoDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to DesignSystemDemoScreen")
    analyticsTracker.trackScreenView("DesignSystemDemoScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DesignSystemDemoDestination>()) {
    DesignSystemDemoScreen(onBackClick = { backStack.popOrGoHome(HomeDestination()) })
  }
}

@Composable
private fun DemoUxStartEntry(destination: DemoUxStartDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to DemoUxStartScreen")
    analyticsTracker.trackScreenView("DemoUxStartScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoUxStartDestination>()) {
    UxFlowStartScreen(
      onNavigateNext = { backStack.add(DemoUxDetailsDestination) },
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}

@Composable
private fun DemoUxDetailsEntry(destination: DemoUxDetailsDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to DemoUxDetailsScreen")
    analyticsTracker.trackScreenView("DemoUxDetailsScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoUxDetailsDestination>()) {
    UxFlowDetailsScreen(
      onNavigateNext = { backStack.add(DemoUxSummaryDestination) },
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}

@Composable
private fun DemoUxSummaryEntry(destination: DemoUxSummaryDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to DemoUxSummaryScreen")
    analyticsTracker.trackScreenView("DemoUxSummaryScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoUxSummaryDestination>()) {
    UxFlowSummaryScreen(
      // Pop summary and details, stopping at a root for short deep-linked stacks.
      onRestartFlow = { repeat(2) { backStack.popOrGoHome(HomeDestination()) } },
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}

@Composable
private fun DemoStartupEntry(destination: DemoStartupDestination, state: NavigationState) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to StartupDemoScreen")
    analyticsTracker.trackScreenView("StartupDemoScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoStartupDestination>()) {
    StartupDemoScreen(onNavigateBack = { backStack.popOrGoHome(HomeDestination()) })
  }
}

@Composable
private fun DemoPerformanceListEntry(
  destination: DemoPerformanceListDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(destination)
  LaunchedEffect(Unit) {
    Log.d(TAG, "Navigated to PerformanceListScreen")
    analyticsTracker.trackScreenView("PerformanceListScreen")
  }
  Box(modifier = Modifier.destinationSemanticModifier<DemoPerformanceListDestination>()) {
    PerformanceListScreen(
      onNavigateToDetail = { itemId ->
        backStack.add(DemoPerformanceDetailDestination(itemId))
      },
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}

@Composable
private fun DemoPerformanceDetailEntry(
  destination: DemoPerformanceDetailDestination,
  state: NavigationState,
) {
  val (backStack, _, analyticsTracker) = state
  Navigation3Adapter.TrackNavigation(
    destination = destination,
    extractArguments = { mapOf("itemId" to it.itemId) },
  )
  LaunchedEffect(Unit) {
    Log.d(
      TAG,
      "Navigated to PerformanceDetailScreen with itemId: ${destination.itemId}",
    )
    analyticsTracker.trackScreenView("PerformanceDetailScreen")
  }
  Box(
    modifier =
      Modifier.destinationSemanticModifier<DemoPerformanceDetailDestination>(
        "item_${destination.itemId}",
      ),
  ) {
    PerformanceDetailScreen(
      itemId = destination.itemId,
      onNavigateBack = { backStack.popOrGoHome(HomeDestination()) },
    )
  }
}
