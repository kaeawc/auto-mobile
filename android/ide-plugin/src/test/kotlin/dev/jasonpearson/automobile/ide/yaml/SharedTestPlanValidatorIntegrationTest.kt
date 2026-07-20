package dev.jasonpearson.automobile.ide.yaml

import dev.jasonpearson.automobile.validation.TestPlanValidator
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedTestPlanValidatorIntegrationTest {

  @Test
  fun `validates a plan through the shared validator`() {
    val result =
      TestPlanValidator.validateYaml(
        """
        name: test-plan
        steps:
          - tool: observe
        """
          .trimIndent()
      )

    assertTrue("The plugin classpath must expose the shared schema", result.valid)
    assertTrue(result.errors.isEmpty())
  }

  @Test
  fun `reports an unknown tool through the shared validator`() {
    val result =
      TestPlanValidator.validateYaml(
        """
        name: test-plan
        steps:
          - tool: notATool
        """
          .trimIndent()
      )

    assertFalse(result.valid)
    assertTrue(result.errors.any { it.message.contains("Unknown tool 'notATool'") })
  }
}
