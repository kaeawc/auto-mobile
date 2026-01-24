package dev.jasonpearson.automobile.ide.navigation

data class ScreenNode(
    val id: String,
    val name: String,
    val type: String, // Activity, Fragment, Composable
    val packageName: String,
    val testCoverage: Int, // percentage
    val transitionCount: Int,
)

data class ScreenTransition(
    val id: String,
    val fromScreen: String,
    val toScreen: String,
    val trigger: String, // "tap", "intent", "back", "swipe"
    val element: String?, // UI element that triggers
    val avgLatencyMs: Int,
    val failureRate: Float,
)

// Mock data for development
object NavigationMockData {
    val screens = listOf(
        ScreenNode("main", "MainActivity", "Activity", "com.example.app", 85, 4),
        ScreenNode("home", "HomeScreen", "Composable", "com.example.app.ui", 72, 3),
        ScreenNode("settings", "SettingsFragment", "Fragment", "com.example.app.settings", 45, 2),
        ScreenNode("profile", "ProfileScreen", "Composable", "com.example.app.ui", 60, 2),
        ScreenNode("login", "LoginActivity", "Activity", "com.example.app.auth", 90, 1),
    )

    val transitions = listOf(
        ScreenTransition("t1", "HomeScreen", "SettingsFragment", "tap", "Settings Icon", 120, 0.01f),
        ScreenTransition("t2", "HomeScreen", "ProfileScreen", "tap", "Profile Avatar", 85, 0.0f),
        ScreenTransition("t3", "LoginActivity", "MainActivity", "intent", null, 250, 0.02f),
        ScreenTransition("t4", "SettingsFragment", "HomeScreen", "back", null, 45, 0.0f),
        ScreenTransition("t5", "ProfileScreen", "HomeScreen", "back", null, 40, 0.0f),
        ScreenTransition("t6", "MainActivity", "HomeScreen", "intent", null, 100, 0.0f),
    )
}
