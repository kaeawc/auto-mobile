package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * A tappable trailing icon follows the field's `enabledWhen`: a disabled field has no live icon.
 */
@RunWith(RobolectricTestRunner::class)
class PrototypeTextFieldTrailingIconTest {
  @get:Rule val compose = createComposeRule()
  private val interactions = mutableListOf<PrototypeInteraction>()
  private val go = listOf<PrototypeAction>(PrototypeEmitAction("clear"))

  private fun show(ready: Boolean) {
    val field =
      PrototypeTextFieldNode(
        testTag = "field",
        stateKey = "query",
        trailingIcon = PrototypeAppBarAction("close", "Clear", go),
        enabledWhen = PrototypeCondition("ready", PrototypeScalar.BooleanValue(true)),
      )
    val spec =
      PrototypeSpec(
        "field",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("ready" to PrototypeScalar.BooleanValue(ready), "query" to PrototypeScalar.Text("")),
        field,
      )
    compose.setContent {
      CompositionLocalProvider(
        LocalPrototypeFillsWindow provides true,
        LocalPrototypeMotion provides false,
      ) {
        Box(Modifier.fillMaxSize()) {
          PrototypeSpecContent(mapPrototypeSpec(spec).root) { interactions += it }
        }
      }
    }
  }

  @Test
  fun `trailing icon button is disabled and inert while the field is disabled`() {
    show(ready = false)
    compose.onNodeWithTag("field.trailingIcon").assertIsNotEnabled().performClick()
    compose.waitForIdle()
    assertTrue(interactions.isEmpty())
  }

  @Test
  fun `trailing icon button taps while the field is enabled`() {
    show(ready = true)
    compose.onNodeWithTag("field.trailingIcon").assertIsEnabled().performClick()
    assertEquals(
      listOf<PrototypeInteraction>(
        PrototypeInteraction.Guarded("root", PrototypeInteraction.Tap(go)),
      ),
      interactions,
    )
  }
}
