package dev.jasonpearson.automobile.ide.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import dev.jasonpearson.automobile.ide.daemon.AutoMobileClient
import dev.jasonpearson.automobile.ide.datasource.DataSourceMode
import dev.jasonpearson.automobile.ide.datasource.DataSourceFactory
import dev.jasonpearson.automobile.ide.datasource.NavigationGraph
import com.intellij.openapi.diagnostic.Logger

private val LOG = Logger.getInstance("NavigationDashboard")

enum class NavigationSection { FlowMap, ScreenDetail, TransitionDetail }

@Composable
fun NavigationDashboard(
    highlightedScreens: List<String> = emptyList(),  // Screen names to highlight (e.g., from test flow)
    currentStepScreen: String? = highlightedScreens.lastOrNull(),  // Current step being replayed
    onHighlightCleared: () -> Unit = {},  // Called when user interacts to clear external highlights
    onFocusModeChanged: (Boolean) -> Unit = {},  // Called when zoom causes content to extend beyond canvas
    headerHeightPx: Float = 0f,  // Height of header area to check overlap against
    dataSourceMode: DataSourceMode = DataSourceMode.Fake,
    clientProvider: (() -> AutoMobileClient)? = null,  // MCP client for real data
) {
    var currentSection by remember { mutableStateOf(NavigationSection.FlowMap) }
    var selectedScreenId by remember { mutableStateOf<String?>(null) }
    var selectedTransitionId by remember { mutableStateOf<String?>(null) }

    // Reset focus mode when navigating away from FlowMap
    LaunchedEffect(currentSection) {
        if (currentSection != NavigationSection.FlowMap) {
            onFocusModeChanged(false)
        }
    }

    // Fetch navigation data from data source
    var navigationGraph by remember { mutableStateOf<NavigationGraph?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(dataSourceMode, clientProvider) {
        LOG.info("Loading navigation data with mode: $dataSourceMode, clientProvider=${if (clientProvider != null) "present" else "null"}")
        isLoading = true
        error = null
        kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            try {
                val dataSource = DataSourceFactory.createNavigationDataSource(dataSourceMode, clientProvider)
                when (val result = dataSource.getNavigationGraph()) {
                    is dev.jasonpearson.automobile.ide.datasource.Result.Success -> {
                        LOG.info("Navigation data loaded: ${result.data.screens.size} screens, ${result.data.transitions.size} transitions")
                        navigationGraph = result.data
                        isLoading = false
                    }
                    is dev.jasonpearson.automobile.ide.datasource.Result.Error -> {
                        LOG.warn("Failed to load navigation data: ${result.message}")
                        error = result.message
                        isLoading = false
                    }
                    is dev.jasonpearson.automobile.ide.datasource.Result.Loading -> {
                        // Keep loading state
                    }
                }
            } catch (e: Exception) {
                LOG.error("Exception loading navigation data", e)
                error = e.message ?: "Unknown error"
                isLoading = false
            }
        }
    }

    // Use fetched data or fall back to empty lists
    val screens = navigationGraph?.screens ?: emptyList()
    val transitions = navigationGraph?.transitions ?: emptyList()

    // Helper to navigate to a screen by name
    val navigateToScreen: (String) -> Unit = { screenName ->
        // Find screen by name and set its ID
        val screen = screens.find { it.name == screenName }
        if (screen != null) {
            selectedScreenId = screen.id
            currentSection = NavigationSection.ScreenDetail
            onHighlightCleared()  // Clear external highlights when navigating
        }
    }

    when (currentSection) {
        NavigationSection.FlowMap ->
            Box(modifier = Modifier.fillMaxSize()) {
                NavigationCanvasView(
                    screens = screens,
                    transitions = transitions,
                    onScreenSelected = { screenId ->
                        selectedScreenId = screenId
                        currentSection = NavigationSection.ScreenDetail
                        onHighlightCleared()
                    },
                    externalHighlightedScreens = highlightedScreens,
                    currentReplayScreen = currentStepScreen,
                    onFocusModeChanged = onFocusModeChanged,
                    headerHeightPx = headerHeightPx,
                )
            }

        NavigationSection.ScreenDetail -> {
            val screen = screens.find { it.id == selectedScreenId }
                ?: screens.find { it.name == selectedScreenId }
                ?: screens.first()

            ScreenDetailView(
                screen = screen,
                transitions = transitions,
                onBack = { currentSection = NavigationSection.FlowMap },
                onScreenSelected = navigateToScreen,
            )
        }

        NavigationSection.TransitionDetail -> {
            val transition = transitions.find { it.id == selectedTransitionId }
                ?: transitions.first()

            TransitionDetailView(
                transition = transition,
                onBack = { currentSection = NavigationSection.FlowMap },
                onScreenSelected = navigateToScreen,
            )
        }
    }
}
