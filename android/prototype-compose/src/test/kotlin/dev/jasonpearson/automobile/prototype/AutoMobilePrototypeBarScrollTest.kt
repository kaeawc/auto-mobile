package dev.jasonpearson.automobile.prototype

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AutoMobilePrototypeBarScrollTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  private fun render() {
    val errors = mutableListOf<PrototypeLoadError>()
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          embeddedSpec(
            """{"type":"column","children":[{"type":"topAppBar","testTag":"top","title":"Feed","variant":"large","onScroll":"exitUntilCollapsed","scroll":"feed"},{"type":"scroll","id":"feed","testTag":"feed","style":{"height":{"dp":224}},"child":{"type":"column","children":[{"type":"text","text":"First"},{"type":"spacer","style":{"height":{"dp":2000}}}]}},{"type":"bottomNav","testTag":"bottom","stateKey":"tab","onScroll":"hide","scroll":"feed","items":[{"icon":"home","label":"Home"},{"icon":"search","label":"Search"}]}]}""",
            """"state":{"tab":0},""",
          ),
          storage = FakePrototypeStorage(),
          network = PrototypeNetwork(FakePrototypeHttp()),
          onError = { errors += it },
        )
      }
    }
    compose.runOnIdle { assertTrue("$errors", errors.isEmpty()) }
  }

  private fun scroll200dp() {
    compose.onNodeWithTag("feed").performTouchInput {
      val distance = with(compose.density) { 200.dp.toPx() }
      swipe(Offset(centerX, bottom - 4), Offset(centerX, bottom - 4 - distance), 300)
    }
    compose.waitForIdle()
  }

  @Test
  fun `exitUntilCollapsed reaches small height after 200dp scroll`() {
    render()
    scroll200dp()
    compose.onNodeWithTag("top").assertHeightIsEqualTo(64.dp)
  }

  @Test
  fun `hidden navigation leaves semantics and hit testing`() {
    render()
    compose.onNodeWithTag("bottom").assertExists()
    scroll200dp()
    compose.onNodeWithTag("bottom").assertDoesNotExist()
    compose.onNodeWithText("Home").assertDoesNotExist()
  }
}
