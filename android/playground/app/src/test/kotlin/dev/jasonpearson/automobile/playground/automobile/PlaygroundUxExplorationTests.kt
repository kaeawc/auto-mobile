package dev.jasonpearson.automobile.playground.automobile

import dev.jasonpearson.automobile.junit.AutoMobilePlan
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for UX exploration workflows documented in docs/using/ux-exploration.md
 *
 * These tests verify the navigation graph exploration capabilities and multi-screen user flows in
 * the Playground demo app.
 */
class PlaygroundUxExplorationTests {

  @Test
  fun testNavigateToDemoIndex() {
    // Verifies navigation from home screen to Demo Index
    val result =
        AutoMobilePlan("test-plans/playground/ux-exploration/navigate-demo-index.yaml").execute()
    assertTrue(result.success)
  }

  @Test
  fun testCompleteUxFlow() {
    // Tests the full UX exploration flow: Start -> Details -> Summary
    val result =
        AutoMobilePlan("test-plans/playground/ux-exploration/complete-ux-flow.yaml").execute()
    assertTrue(result.success)
  }

  @Test
  fun testNavigateBackThroughFlow() {
    // Tests reverse navigation through the UX flow
    val result =
        AutoMobilePlan("test-plans/playground/ux-exploration/navigate-back-through-flow.yaml")
            .execute()
    assertTrue(result.success)
  }
}
