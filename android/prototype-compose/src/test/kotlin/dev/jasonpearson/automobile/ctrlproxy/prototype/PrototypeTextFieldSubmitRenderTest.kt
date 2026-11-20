package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.fixtureFile
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A rendered textField's keyboard action and state writes to its key while focused. */
@RunWith(RobolectricTestRunner::class)
class PrototypeTextFieldSubmitRenderTest {
  @get:Rule val compose = createComposeRule()
  private val events = mutableListOf<PrototypeEvent>()

  private fun show(field: PrototypeTextFieldNode): PrototypeRuntime =
    show(
      PrototypeSpec(
        "field-test",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf(
          "draft" to PrototypeScalar.Text(""),
          "submitted" to PrototypeScalar.Text("no"),
        ),
        field,
      ),
    )

  private fun show(spec: PrototypeSpec): PrototypeRuntime {
    val runtime =
      PrototypeRuntime(
        spec,
        sink = { events += it },
        nextSequence = { events.size.toLong() + 1 },
        warn = {},
      )
    compose.setContent {
      Box(Modifier.width(300.dp).height(400.dp)) {
        PrototypeRuntimeContent(runtime) { runtime.handle(it) }
      }
    }
    compose.waitForIdle()
    return runtime
  }

  private fun shows(text: String) =
    SemanticsMatcher.expectValue(
      SemanticsProperties.EditableText,
      androidx.compose.ui.text.AnnotatedString(text),
    )

  @OptIn(ExperimentalTestApi::class)
  @Test
  fun `enter on a field with an IME action runs onSubmit instead of adding a newline`() {
    val runtime =
      show(
        PrototypeTextFieldNode(
          stateKey = "draft",
          testTag = "field",
          imeAction = "done",
          onSubmit = listOf(PrototypeSetStateAction("submitted", PrototypeScalar.Text("yes"))),
        ),
      )
    compose.onNodeWithTag("field").performClick().performTextInput("Water the plants")
    compose.onNodeWithTag("field").performKeyInput { pressKey(Key.Enter) }
    compose.waitForIdle()
    compose.onNodeWithTag("field").assert(shows("Water the plants"))
    assertEquals(PrototypeScalar.Text("Water the plants"), runtime.current.state["draft"])
    assertEquals(PrototypeScalar.Text("yes"), runtime.current.state["submitted"])
  }

  @OptIn(ExperimentalTestApi::class)
  @Test
  fun `an explicitly multiline field keeps enter as a newline`() {
    val runtime =
      show(PrototypeTextFieldNode(stateKey = "draft", testTag = "field", multiline = true))
    compose.onNodeWithTag("field").performClick().performTextInput("line")
    compose.onNodeWithTag("field").performKeyInput { pressKey(Key.Enter) }
    compose.waitForIdle()
    assertEquals(PrototypeScalar.Text("line\n"), runtime.current.state["draft"])
  }

  @Test
  fun `setState on the focused field's key replaces the typed text`() {
    val runtime = show(PrototypeTextFieldNode(stateKey = "draft", testTag = "field"))
    compose.onNodeWithTag("field").performClick().performTextInput("Water the plants")
    compose.waitForIdle()
    compose.runOnUiThread {
      runBlocking {
        runtime.handle(
          PrototypeInteraction.Tap(
            listOf(PrototypeSetStateAction("draft", PrototypeScalar.Text(""))),
          ),
        )
      }
    }
    compose.waitForIdle()
    compose.onNodeWithTag("field").assertIsFocused().assert(shows(""))
    // The cleared field keeps editing from the new text.
    compose.onNodeWithTag("field").performTextInput("Next")
    compose.waitForIdle()
    compose.onNodeWithTag("field").assert(shows("Next"))
    assertEquals(PrototypeScalar.Text("Next"), runtime.current.state["draft"])
  }

  @OptIn(ExperimentalTestApi::class)
  @Test
  fun `shared text-field-actions fixture clears the focused field and submits on enter`() {
    val text = fixtureFile("prototype-spec/valid/text-field-actions.json").readText()
    val spec =
      when (val result = PrototypeSpecValidator.validate(text)) {
        is PrototypeSpecValidation.Success -> result.spec
        is PrototypeSpecValidation.Failure -> error("${result.error}")
      }
    val runtime = show(spec)
    val search = compose.onAllNodes(hasSetTextAction())[0]
    search.performClick().performTextReplacement("coffee!")
    compose.waitForIdle()
    search.assert(shows("coffee!"))
    compose.onNodeWithContentDescription("Clear").performClick()
    compose.waitForIdle()
    search.assertIsFocused().assert(shows(""))
    assertEquals(PrototypeScalar.Text(""), runtime.current.state["query"])
    search.performTextInput("tea")
    search.performKeyInput { pressKey(Key.Enter) }
    compose.waitForIdle()
    search.assert(shows("tea"))
    assertTrue(events.any { it.kind == PrototypeEventKind.EMIT && it.name == "search" })
  }
}
