package dev.jasonpearson.automobile.ide.navigation

data class ScreenNode(
    val id: String,
    val name: String,
    val type: String, // Activity, Fragment, Composable
    val packageName: String,
    val testCoverage: Int, // percentage
    val transitionCount: Int,
    val discoveredAt: Long, // epoch millis - older = discovered earlier during exploration
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

// Mock data for development - Simple messaging app (8 screens)
// Timestamps simulate AutoMobile exploring the app starting from Splash
object NavigationMockData {
    private const val BASE_TIME = 1705000000000L // Jan 11, 2024

    val screens = listOf(
        // Discovery order: Splash → Login → Signup → Home → ChatList → Chat → Profile → Settings
        ScreenNode("splash", "Splash", "Activity", "com.chat.app", 95, 2, BASE_TIME),
        ScreenNode("login", "Login", "Composable", "com.chat.auth", 88, 3, BASE_TIME + 2_000),
        ScreenNode("signup", "Signup", "Composable", "com.chat.auth", 82, 2, BASE_TIME + 8_000),
        ScreenNode("home", "Home", "Composable", "com.chat.main", 90, 5, BASE_TIME + 15_000),
        ScreenNode("chats", "ChatList", "Composable", "com.chat.main", 85, 2, BASE_TIME + 18_000),
        ScreenNode("chat", "Chat", "Composable", "com.chat.main", 80, 2, BASE_TIME + 22_000),
        ScreenNode("profile", "Profile", "Composable", "com.chat.user", 78, 2, BASE_TIME + 30_000),
        ScreenNode("settings", "Settings", "Composable", "com.chat.user", 75, 1, BASE_TIME + 35_000),
    )

    val transitions = listOf(
        // Splash → Auth or Home
        ScreenTransition("t01", "Splash", "Login", "intent", null, 150, 0.01f),
        ScreenTransition("t02", "Splash", "Home", "intent", null, 120, 0.0f),

        // Auth flow
        ScreenTransition("t03", "Login", "Signup", "tap", "Create Account", 80, 0.0f),
        ScreenTransition("t04", "Login", "Home", "tap", "Login", 350, 0.03f),
        ScreenTransition("t05", "Signup", "Home", "tap", "Sign Up", 280, 0.02f),
        ScreenTransition("t06", "Signup", "Login", "back", null, 40, 0.0f),

        // Home hub → tabs
        ScreenTransition("t10", "Home", "ChatList", "tap", "Chats Tab", 50, 0.0f),
        ScreenTransition("t11", "Home", "Profile", "tap", "Profile Tab", 50, 0.0f),
        ScreenTransition("t12", "Home", "Settings", "tap", "Settings Tab", 50, 0.0f),

        // ChatList → Chat detail
        ScreenTransition("t20", "ChatList", "Chat", "tap", "Conversation", 90, 0.01f),
        ScreenTransition("t21", "Chat", "ChatList", "back", null, 45, 0.0f),
    )
}
