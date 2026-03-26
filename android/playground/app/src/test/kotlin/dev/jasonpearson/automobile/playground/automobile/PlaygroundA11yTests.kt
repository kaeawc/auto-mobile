package dev.jasonpearson.automobile.playground.automobile

import dev.jasonpearson.automobile.junit.AutoMobilePlan
import dev.jasonpearson.automobile.junit.AutoMobilePlanExecutionOptions
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for accessibility audit workflows documented in docs/using/a11y/
 *
 * These tests verify:
 * - docs/using/a11y/contrast.md (WCAG contrast ratio compliance)
 * - docs/using/a11y/tap-targets.md (minimum tap target size requirements)
 */
class PlaygroundA11yTests {

  @Test
  fun testContrastAudit() {
    // Audits the Contrast Demo screen for WCAG 2.1 Level AA violations
    // Expects to find intentional low-contrast text and button examples
    val result =
        AutoMobilePlan("test-plans/playground/accessibility/contrast-audit.yaml").execute()
    assertTrue(result.success)
  }

  @Test
  fun testTapTargetsAudit() {
    // Audits the Tap Targets Demo screen for size violations
    // Expects to find elements below 48x48dp Material Design guideline
    val result =
        AutoMobilePlan("test-plans/playground/accessibility/tap-targets-audit.yaml").execute()
    assertTrue(result.success)
  }

  @Test
  fun testCombinedAccessibilityAudit() {
    // Runs comprehensive accessibility audit across multiple demo screens
    // Covers both contrast and tap target accessibility issues
    val result =
        AutoMobilePlan("test-plans/playground/accessibility/combined-a11y-audit.yaml")
            .execute(AutoMobilePlanExecutionOptions(timeoutMs = 90000L))
    assertTrue(result.success)
  }
}
