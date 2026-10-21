package dev.jasonpearson.automobile.prototype

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A same-axis `scroll` inside a `scroll` is valid; it must render, not crash Compose (#13725). */
@RunWith(RobolectricTestRunner::class)
class AutoMobilePrototypeNestedScrollTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  private fun render(root: String): List<PrototypeLoadError> {
    val errors = mutableListOf<PrototypeLoadError>()
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          embeddedSpec(root),
          storage = FakePrototypeStorage(),
          network = PrototypeNetwork(FakePrototypeHttp()),
          onError = { errors += it },
        )
      }
    }
    return errors
  }

  private fun scroll(axis: String, child: String, style: String = "") =
    """{"type":"scroll","axis":"$axis","testTag":"$axis-scroll"$style,"child":$child}"""

  @Test
  fun `unbounded vertical scroll inside a vertical scroll renders its content`() {
    val errors =
      render(
        scroll(
          "vertical",
          scroll("vertical", """{"type":"text","testTag":"leaf","text":"Leaf"}"""),
        ),
      )
    compose.onNodeWithTag("leaf").assertExists()
    compose.runOnIdle { assertTrue("$errors", errors.isEmpty()) }
  }

  @Test
  fun `unbounded horizontal scroll inside a horizontal scroll renders its content`() {
    val errors =
      render(
        scroll(
          "horizontal",
          scroll("horizontal", """{"type":"text","testTag":"leaf","text":"Leaf"}"""),
        ),
      )
    compose.onNodeWithTag("leaf").assertExists()
    compose.runOnIdle { assertTrue("$errors", errors.isEmpty()) }
  }

  @Test
  fun `bounded inner scroll keeps its own scroll range`() {
    val tall = """{"type":"spacer","style":{"height":{"dp":2000}}}"""
    val inner =
      """{"type":"scroll","axis":"vertical","testTag":"inner","style":{"height":{"dp":100}},"child":$tall}"""
    render("""{"type":"scroll","axis":"vertical","child":$inner}""")
    val range =
      compose
        .onNodeWithTag("inner")
        .fetchSemanticsNode()
        .config[SemanticsProperties.VerticalScrollAxisRange]
    compose.runOnIdle { assertTrue("inner scrolls: ${range.maxValue()}", range.maxValue() > 0f) }
  }

  @Test
  fun `unbounded inner scroll has nothing of its own to scroll`() {
    val tall = """{"type":"spacer","style":{"height":{"dp":2000}}}"""
    val inner = """{"type":"scroll","axis":"vertical","testTag":"inner","child":$tall}"""
    render("""{"type":"scroll","axis":"vertical","child":$inner}""")
    val range =
      compose
        .onNodeWithTag("inner")
        .fetchSemanticsNode()
        .config[SemanticsProperties.VerticalScrollAxisRange]
    compose.runOnIdle { assertEquals(0f, range.maxValue()) }
  }
}
