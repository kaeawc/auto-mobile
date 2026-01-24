package dev.jasonpearson.automobile.ide.test

data class TestCase(
    val id: String,
    val name: String,
    val className: String,
    val packageName: String,
    val filePath: String,  // Path to the test file for opening in editor
    val lastRunTime: Long?,  // Epoch millis
    val lastRunStatus: TestStatus?,
    val runCount: Int,  // For popularity sorting
    val screensVisited: List<String>,  // Screen names for nav graph integration
    val avgDurationMs: Int,
    val flakinessScore: Float,  // 0.0 = stable, 1.0 = always flaky
)

enum class TestStatus { Passed, Failed, Skipped, Running }

data class TestRun(
    val id: String,
    val testId: String,
    val testName: String,
    val status: TestStatus,
    val startTime: Long,
    val durationMs: Int,
    val steps: List<TestStep>,
    val screensVisited: List<String>,
    val errorMessage: String? = null,
    val deviceId: String,
    val deviceName: String,
)

data class TestStep(
    val id: String,
    val index: Int,
    val action: String,  // "tap", "input", "swipe", "assert", etc.
    val target: String,  // Element description
    val screenshotPath: String?,
    val screenName: String?,
    val durationMs: Int,
    val status: TestStatus,
    val errorMessage: String? = null,
)

data class RecordedAction(
    val timestamp: Long,
    val toolName: String,
    val parameters: Map<String, String>,
    val result: String?,
    val screenBefore: String?,
    val screenAfter: String?,
)

data class GradleModule(
    val name: String,
    val path: String,  // e.g., ":app", ":feature:auth"
    val testSourcePath: String,  // e.g., "src/androidTest/java"
)

// Mock data for development
object TestMockData {
    private const val BASE_TIME = 1705000000000L

    val modules = listOf(
        GradleModule("app", ":app", "src/androidTest/java"),
        GradleModule("feature-auth", ":feature:auth", "src/androidTest/java"),
        GradleModule("feature-chat", ":feature:chat", "src/androidTest/java"),
        GradleModule("feature-profile", ":feature:profile", "src/androidTest/java"),
        GradleModule("core-testing", ":core:testing", "src/main/java"),
    )

    val testCases = listOf(
        TestCase(
            id = "test1",
            name = "testLoginFlow",
            className = "LoginFlowTest",
            packageName = "com.chat.auth",
            filePath = "feature/auth/src/androidTest/java/com/chat/auth/LoginFlowTest.kt",
            lastRunTime = BASE_TIME + 3600_000,
            lastRunStatus = TestStatus.Passed,
            runCount = 47,
            screensVisited = listOf("Splash", "Login", "Home"),
            avgDurationMs = 4500,
            flakinessScore = 0.02f,
        ),
        TestCase(
            id = "test2",
            name = "testSignupValidation",
            className = "SignupTest",
            packageName = "com.chat.auth",
            filePath = "feature/auth/src/androidTest/java/com/chat/auth/SignupTest.kt",
            lastRunTime = BASE_TIME + 3500_000,
            lastRunStatus = TestStatus.Failed,
            runCount = 32,
            screensVisited = listOf("Splash", "Login", "Signup"),
            avgDurationMs = 3200,
            flakinessScore = 0.15f,
        ),
        TestCase(
            id = "test3",
            name = "testSendMessage",
            className = "ChatTest",
            packageName = "com.chat.main",
            filePath = "feature/chat/src/androidTest/java/com/chat/main/ChatTest.kt",
            lastRunTime = BASE_TIME + 3400_000,
            lastRunStatus = TestStatus.Passed,
            runCount = 28,
            screensVisited = listOf("Home", "ChatList", "Chat"),
            avgDurationMs = 6800,
            flakinessScore = 0.05f,
        ),
        TestCase(
            id = "test4",
            name = "testProfileEdit",
            className = "ProfileTest",
            packageName = "com.chat.user",
            filePath = "feature/profile/src/androidTest/java/com/chat/user/ProfileTest.kt",
            lastRunTime = BASE_TIME + 3300_000,
            lastRunStatus = TestStatus.Passed,
            runCount = 19,
            screensVisited = listOf("Home", "Profile", "EditProfile"),
            avgDurationMs = 3100,
            flakinessScore = 0.0f,
        ),
        TestCase(
            id = "test5",
            name = "testNavigationSmoke",
            className = "SmokeTest",
            packageName = "com.chat.app",
            filePath = "app/src/androidTest/java/com/chat/app/SmokeTest.kt",
            lastRunTime = BASE_TIME + 3200_000,
            lastRunStatus = TestStatus.Passed,
            runCount = 156,
            screensVisited = listOf("Splash", "Login", "Home", "ChatList", "Profile", "Settings"),
            avgDurationMs = 12400,
            flakinessScore = 0.08f,
        ),
    )

    val recentRuns = listOf(
        TestRun(
            id = "run1",
            testId = "test1",
            testName = "testLoginFlow",
            status = TestStatus.Passed,
            startTime = BASE_TIME + 3600_000,
            durationMs = 4320,
            steps = listOf(
                TestStep("s1", 0, "launch", "com.chat.app", null, "Splash", 800, TestStatus.Passed),
                TestStep("s2", 1, "wait", "Login screen", null, "Login", 1200, TestStatus.Passed),
                TestStep("s3", 2, "input", "Email field", null, "Login", 450, TestStatus.Passed),
                TestStep("s4", 3, "input", "Password field", null, "Login", 380, TestStatus.Passed),
                TestStep("s5", 4, "tap", "Login button", null, "Login", 290, TestStatus.Passed),
                TestStep("s6", 5, "assert", "Home screen visible", null, "Home", 1200, TestStatus.Passed),
            ),
            screensVisited = listOf("Splash", "Login", "Home"),
            deviceId = "pixel8",
            deviceName = "Pixel 8 API 35",
        ),
        TestRun(
            id = "run2",
            testId = "test2",
            testName = "testSignupValidation",
            status = TestStatus.Failed,
            startTime = BASE_TIME + 3500_000,
            durationMs = 2890,
            steps = listOf(
                TestStep("s1", 0, "launch", "com.chat.app", null, "Splash", 780, TestStatus.Passed),
                TestStep("s2", 1, "tap", "Create Account", null, "Login", 320, TestStatus.Passed),
                TestStep("s3", 2, "input", "Invalid email", null, "Signup", 410, TestStatus.Passed),
                TestStep("s4", 3, "tap", "Sign Up button", null, "Signup", 280, TestStatus.Passed),
                TestStep("s5", 4, "assert", "Error message visible", null, "Signup", 1100, TestStatus.Failed, "Expected error toast not found"),
            ),
            screensVisited = listOf("Splash", "Login", "Signup"),
            errorMessage = "AssertionError: Expected error toast not found within 5000ms",
            deviceId = "pixel8",
            deviceName = "Pixel 8 API 35",
        ),
        TestRun(
            id = "run3",
            testId = "test5",
            testName = "testNavigationSmoke",
            status = TestStatus.Passed,
            startTime = BASE_TIME + 3200_000,
            durationMs = 11980,
            steps = listOf(
                TestStep("s1", 0, "launch", "com.chat.app", null, "Splash", 820, TestStatus.Passed),
                TestStep("s2", 1, "wait", "Login screen", null, "Login", 1100, TestStatus.Passed),
                TestStep("s3", 2, "tap", "Skip login", null, "Login", 280, TestStatus.Passed),
                TestStep("s4", 3, "tap", "Chats tab", null, "Home", 340, TestStatus.Passed),
                TestStep("s5", 4, "assert", "ChatList visible", null, "ChatList", 890, TestStatus.Passed),
                TestStep("s6", 5, "tap", "Profile tab", null, "ChatList", 310, TestStatus.Passed),
                TestStep("s7", 6, "assert", "Profile visible", null, "Profile", 920, TestStatus.Passed),
                TestStep("s8", 7, "tap", "Settings", null, "Profile", 290, TestStatus.Passed),
                TestStep("s9", 8, "assert", "Settings visible", null, "Settings", 880, TestStatus.Passed),
            ),
            screensVisited = listOf("Splash", "Login", "Home", "ChatList", "Profile", "Settings"),
            deviceId = "pixel7",
            deviceName = "Pixel 7 API 34",
        ),
    )
}
