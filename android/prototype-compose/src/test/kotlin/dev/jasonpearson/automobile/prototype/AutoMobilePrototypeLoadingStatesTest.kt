package dev.jasonpearson.automobile.prototype

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createComposeRule
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The `loading-states` fixture draws its three skeleton rows (#14793). The rows hold only an unsized
 * `spacer`, so a spacer that wrapped to nothing collapsed each row to zero width and the whole
 * placeholder rendered blank on Android while iOS filled it.
 */
@RunWith(RobolectricTestRunner::class)
class AutoMobilePrototypeLoadingStatesTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  @Test
  fun `loading skeleton rows have a non-empty size`() {
    val input = fixtureFile("prototype-spec/valid").resolve("loading-states.json").readText()
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          input,
          storage = FakePrototypeStorage(),
          network = PrototypeNetwork(FakePrototypeHttp()),
        )
      }
    }
    val loading =
      compose
        .onAllNodes(
          SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Loading"),
          useUnmergedTree = true,
        )
        .fetchSemanticsNodes()
    assertEquals("three skeleton rows", 3, loading.size)
    loading.forEach {
      assertTrue("skeleton row has no width: ${it.size}", it.size.width > 0)
      assertTrue("skeleton row has no height: ${it.size}", it.size.height > 0)
    }
  }
}
