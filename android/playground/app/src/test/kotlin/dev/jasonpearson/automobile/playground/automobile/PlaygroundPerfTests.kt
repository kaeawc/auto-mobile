package dev.jasonpearson.automobile.playground.automobile

import dev.jasonpearson.automobile.junit.AutoMobilePlan
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutionOptions
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for performance analysis workflows documented in docs/using/perf-analysis/
 *
 * These tests verify:
 * - docs/using/perf-analysis/startup.md (cold boot startup performance)
 * - docs/using/perf-analysis/scroll-framerate.md (scroll performance metrics)
 * - docs/using/perf-analysis/screen-transition.md (navigation transition performance)
 */
class PlaygroundPerfTests {

  @Test
  fun testColdBootStartup() {
    // Measures cold start performance to the Startup Demo screen
    val result =
        AutoMobilePlan("test-plans/playground/performance/startup-cold-boot.yaml")
            .execute(AutoMobilePlanExecutionOptions(timeoutMs = 90000L))
    assertTrue(result.success)
  }

  @Test
  fun testScrollPerformanceList() {
    // Tests scroll framerate on the Performance List screen
    val result =
        AutoMobilePlan("test-plans/playground/performance/scroll-performance-list.yaml").execute()
    assertTrue(result.success)
  }

  @Test
  fun testScreenTransitionPerformance() {
    // Measures screen transition performance from list to detail
    val result =
        AutoMobilePlan("test-plans/playground/performance/screen-transition.yaml").execute()
    assertTrue(result.success)
  }
}
