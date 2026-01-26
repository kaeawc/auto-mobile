package dev.jasonpearson.automobile.ide.datasource

import dev.jasonpearson.automobile.ide.daemon.AutoMobileClient
import dev.jasonpearson.automobile.ide.daemon.McpConnectionException
import dev.jasonpearson.automobile.ide.daemon.TestTimingQuery
import dev.jasonpearson.automobile.ide.test.TestPlatform
import dev.jasonpearson.automobile.ide.test.TestRun
import dev.jasonpearson.automobile.ide.test.TestStatus

/**
 * Real test data source that fetches from MCP resources.
 * Uses the test-timings resource to get actual test data.
 */
class RealTestDataSource(
    private val clientProvider: (() -> AutoMobileClient)? = null,
) : TestDataSource {
    override suspend fun getTestRuns(): Result<List<TestRun>> {
        val provider = clientProvider ?: return Result.Success(emptyList())

        return try {
            val client = provider()
            val summary = client.getTestTimings(TestTimingQuery(limit = 100))

            // Map TestTimingEntry to TestRun
            val testRuns = summary.testTimings.mapIndexed { index, entry ->
                val status = when {
                    entry.statusCounts?.failed ?: 0 > 0 -> TestStatus.Failed
                    entry.successRate >= 1.0 -> TestStatus.Passed
                    entry.successRate > 0 -> TestStatus.Passed
                    else -> TestStatus.Skipped
                }

                TestRun(
                    id = "test-$index",
                    testId = "${entry.testClass}.${entry.testMethod}",
                    testName = entry.testMethod,
                    status = status,
                    startTime = entry.lastRunTimestampMs ?: System.currentTimeMillis(),
                    durationMs = entry.averageDurationMs,
                    steps = emptyList(), // Test timings don't include step details
                    screensVisited = emptyList(), // Not available from timings
                    errorMessage = if (status == TestStatus.Failed) {
                        "Failed ${entry.statusCounts?.failed ?: 0} of ${entry.sampleSize} runs"
                    } else null,
                    deviceId = "unknown",
                    deviceName = "Multiple devices",
                    platform = TestPlatform.Android, // Default, could be inferred
                    videoPath = null,
                    snapshotPath = null,
                    sampleSize = entry.sampleSize,
                )
            }

            Result.Success(testRuns)
        } catch (e: McpConnectionException) {
            Result.Error("MCP server not available: ${e.message}")
        } catch (e: Exception) {
            Result.Error("Failed to load test data: ${e.message}")
        }
    }
}
