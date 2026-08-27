package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class TestRunStep(
  val id: Int,
  val index: Int,
  val action: String,
  val target: String? = null,
  val screenshotPath: String? = null,
  val screenName: String? = null,
  val durationMs: Int,
  val status: String, // "completed", "failed", "skipped"
  val errorMessage: String? = null,
)

@Serializable
data class TestRunEntry(
  val id: Int,
  val testClass: String,
  val testMethod: String,
  val testName: String,
  val status: String, // "passed", "failed", "skipped"
  val startTime: Long,
  val durationMs: Int,
  val deviceId: String? = null,
  val deviceName: String? = null,
  val platform: String? = null,
  val errorMessage: String? = null,
  val videoPath: String? = null,
  val snapshotPath: String? = null,
  val steps: List<TestRunStep> = emptyList(),
  val screensVisited: List<String> = emptyList(),
  val sampleSize: Int = 0,
)

@Serializable
data class TestRunQuery(
  val lookbackDays: Int? = null,
  val limit: Int? = null,
  val orderDirection: String? = null,
  val latestOnly: Boolean? = null,
  val deviceId: String? = null,
)

@Serializable
data class TestRunSummary(
  val testRuns: List<TestRunEntry> = emptyList(),
  val generatedAt: String? = null,
  val totalRuns: Int = 0,
  val query: JsonObject? = null,
  val filters: JsonObject? = null,
)

private const val TEST_RUN_RESOURCE_URI = "automobile:test-runs"

fun TestRunQuery.toResourceUri(): String {
  return ResourceUriBuilder(TEST_RUN_RESOURCE_URI)
    .apply {
      add("lookbackDays", lookbackDays)
      add("limit", limit)
      add("orderDirection", orderDirection)
      add("latestOnly", latestOnly)
      add("deviceId", deviceId)
    }
    .build()
}
