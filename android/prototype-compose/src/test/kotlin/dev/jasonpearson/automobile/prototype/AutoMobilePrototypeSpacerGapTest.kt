package dev.jasonpearson.automobile.prototype

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * A spacer sized on one axis is a gap, not a filler. `doc-example-2` puts a 16dp-wide spacer in a
 * horizontally scrolling row above a bottom nav; filling the spacer's unsized height stretched that
 * row over the whole column and pushed the bottom nav out of the layout.
 */
@RunWith(RobolectricTestRunner::class)
class AutoMobilePrototypeSpacerGapTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  @Test
  fun `a width-only spacer leaves room for the bottom nav`() {
    val input = fixtureFile("prototype-spec/valid").resolve("doc-example-2.json").readText()
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          input,
          storage = FakePrototypeStorage(),
          network = PrototypeNetwork(FakePrototypeHttp()),
        )
      }
    }
    val home = compose.onNodeWithText("Home", useUnmergedTree = true).fetchSemanticsNode()
    assertTrue("bottom nav item has no height: ${home.size}", home.size.height > 0)
  }
}
