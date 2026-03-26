package dev.jasonpearson.automobile.playground.automobile

import dev.jasonpearson.automobile.junit.AutoMobilePlan
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for bug reproduction workflows documented in docs/using/reproducing-bugs.md
 *
 * These tests verify:
 * - Systematic bug reproduction with exact steps
 * - Creating automated regression tests from bug reports
 * - Verifying bug fixes and correct behavior
 */
class PlaygroundBugReproTests {

  @Test
  fun testReproduceCounterBug() {
    // Reproduces the intentional counter bug in the Bug Repro Demo
    val result =
        AutoMobilePlan("test-plans/playground/bug-repro/reproduce-counter-bug.yaml").execute()
    assertTrue(result.success)
  }

  @Test
  fun testVerifyCorrectBehaviorWithoutBug() {
    // Regression test verifying correct counter behavior when bug is disabled
    val result =
        AutoMobilePlan("test-plans/playground/bug-repro/verify-fix-with-bug-disabled.yaml")
            .execute()
    assertTrue(result.success)
  }
}
