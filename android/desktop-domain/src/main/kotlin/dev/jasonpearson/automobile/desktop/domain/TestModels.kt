package dev.jasonpearson.automobile.desktop.domain

public data class TestCase(
    val id: String,
    val name: String,
    val className: String,
    val packageName: String,
    val filePath: String,
    val lastRunTime: Long?,
    val lastRunStatus: TestStatus?,
    val runCount: Int,
    val screensVisited: List<String>,
    val avgDurationMs: Int,
    val flakinessScore: Float,
)

public enum class TestStatus {
  Passed,
  Failed,
  Skipped,
  Running,
}

public enum class TestPlatform {
  Android,
  iOS,
}

public data class TestRun(
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
    val platform: TestPlatform,
    val videoPath: String? = null,
    val snapshotPath: String? = null,
    val sampleSize: Int = 0,
)

public data class TestStep(
    val id: String,
    val index: Int,
    val action: String,
    val target: String,
    val screenshotPath: String?,
    val screenName: String?,
    val durationMs: Int,
    val status: TestStatus,
    val errorMessage: String? = null,
)

public data class RecordedAction(
    val timestamp: Long,
    val toolName: String,
    val parameters: Map<String, String>,
    val result: String?,
    val screenBefore: String?,
    val screenAfter: String?,
)

public data class GradleModule(
    val name: String,
    val path: String,
    val testSourcePath: String,
)

public data class ExportedPlan(
    val recordingId: String,
    val planName: String,
    val planContent: String,
    val stepCount: Int,
    val durationMs: Long,
)
