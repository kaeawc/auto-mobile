package dev.jasonpearson.automobile.prototype

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A dialog whose custom content is taller than the screen keeps its actions on it (#14584). The
 * `material-app-bar-dialog-pickers` alarm dialog holds a time and a date picker; on a 360x640
 * surface they pushed the Save and Cancel buttons below the screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w360dp-h640dp-mdpi")
class AutoMobilePrototypeDialogScrollTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  @Test
  fun `a tall dialog keeps its buttons on screen`() {
    val fixture =
      Json.parseToJsonElement(
        fixtureFile("prototype-spec/valid")
          .resolve("material-app-bar-dialog-pickers.json")
          .readText(),
      ) as JsonObject
    val state = fixture["state"] as JsonObject
    val input =
      JsonObject(fixture + ("state" to JsonObject(state + ("editing" to JsonPrimitive(true)))))
        .toString()
    compose.setContent {
      host.Content {
        AutoMobilePrototype(
          input,
          storage = FakePrototypeStorage(),
          network = PrototypeNetwork(FakePrototypeHttp()),
        )
      }
    }
    compose.onNodeWithTag("edit.confirm", useUnmergedTree = true).assertIsDisplayed()
    compose.onNodeWithTag("edit.dismiss", useUnmergedTree = true).assertIsDisplayed()
  }
}
