package dev.jasonpearson.automobile.ide.navigation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier

enum class NavigationSection { FlowMap, ScreenDetail, TransitionDetail }

@Composable
fun NavigationDashboard() {
    var currentSection by remember { mutableStateOf(NavigationSection.FlowMap) }
    var selectedScreenId by remember { mutableStateOf<String?>(null) }
    var selectedTransitionId by remember { mutableStateOf<String?>(null) }

    // Use mock data
    val screens = remember { NavigationMockData.screens }
    val transitions = remember { NavigationMockData.transitions }

    // Helper to navigate to a screen by name
    val navigateToScreen: (String) -> Unit = { screenName ->
        // Find screen by name and set its ID
        val screen = screens.find { it.name == screenName }
        if (screen != null) {
            selectedScreenId = screen.id
            currentSection = NavigationSection.ScreenDetail
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
                    },
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
