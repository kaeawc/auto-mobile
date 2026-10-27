package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.adaptive.Posture
import androidx.compose.material3.adaptive.WindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.window.core.layout.WindowSizeClass
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w400dp-h1100dp")
class PrototypeAdaptiveTest {
  @get:Rule val compose = createComposeRule()

  private fun spec(kind: String): PrototypeSpec {
    val pane = { tag: String -> PrototypeTextNode(text = tag, testTag = tag) }
    val root =
      when (kind) {
        "listDetail" ->
          PrototypeAdaptiveNode(
            kind = kind,
            testTag = "adaptive",
            selectionKey = "selection",
            list = pane("List"),
            detail = pane("Detail"),
          )
        "navigationSuite" ->
          PrototypeAdaptiveNode(
            kind = kind,
            testTag = "adaptive",
            stateKey = "selection",
            items =
              listOf(
                PrototypeRadioOption("", "Home"),
                PrototypeRadioOption("settings", "Settings"),
              ),
            content = pane("Content"),
          )
        else ->
          PrototypeAdaptiveNode(
            kind = kind,
            testTag = "adaptive",
            openKey = "open",
            main = pane("Main"),
            supporting = pane("Supporting"),
          )
      }
    return PrototypeSpec(
      "adaptive",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      mapOf(
        "selection" to PrototypeScalar.Text(""),
        "open" to PrototypeScalar.BooleanValue(true),
      ),
      root,
    )
  }

  private fun show(kind: String, width: Int): MutableState<PrototypeSpec> {
    val state = mutableStateOf(spec(kind))
    val info = WindowAdaptiveInfo(WindowSizeClass.compute(width.toFloat(), 900f), Posture())
    compose.setContent {
      MaterialTheme {
        Box(Modifier.requiredSize(width.dp, 900.dp)) {
          RenderPrototypeAdaptive(
            mapPrototypeSpec(state.value).root,
            interact = { interaction ->
              val change =
                when (interaction) {
                  is PrototypeInteraction.Choose ->
                    interaction.key to PrototypeScalar.Text(interaction.value)
                  is PrototypeInteraction.Toggle ->
                    interaction.key to PrototypeScalar.BooleanValue(false)
                  else -> return@RenderPrototypeAdaptive
                }
              state.value = state.value.copy(state = state.value.state.orEmpty() + change)
            },
            windowInfo = info,
          )
        }
      }
    }
    return state
  }

  @Test
  fun compactListPushAndBack() {
    val state = show("listDetail", 400)
    compose.onNodeWithTag("List").assertIsDisplayed()
    compose.onNodeWithTag("Detail").assertIsNotDisplayed()
    compose.runOnIdle {
      state.value =
        state.value.copy(
          state = state.value.state.orEmpty() + ("selection" to PrototypeScalar.Text("row")),
        )
    }
    compose.onNodeWithTag("Detail").assertIsDisplayed()
    compose.onNodeWithTag("List").assertIsNotDisplayed()
    compose.onNodeWithTag("adaptive.back").performClick()
    compose.onNodeWithTag("List").assertIsDisplayed()
    compose.runOnIdle {
      assertEquals(PrototypeScalar.Text(""), state.value.state?.get("selection"))
    }
  }

  @Test
  @Config(qualifiers = "w900dp-h1100dp")
  fun expandedListShowsBoth() {
    show("listDetail", 900)
    compose.onNodeWithTag("List").assertIsDisplayed()
    compose.onNodeWithTag("Detail").assertIsDisplayed()
  }

  private fun navigation(width: Int, expected: NavigationSuiteType) {
    val state = show("navigationSuite", width)
    assertEquals(expected, adaptiveNavigationType(WindowSizeClass.compute(width.toFloat(), 900f)))
    compose.onNodeWithTag("Content").assertIsDisplayed()
    compose.onNodeWithTag("adaptive.item-1").performClick()
    compose.runOnIdle {
      assertEquals(PrototypeScalar.Text("settings"), state.value.state?.get("selection"))
    }
  }

  @Test fun compactNavigationBar() = navigation(400, NavigationSuiteType.NavigationBar)

  @Test
  @Config(qualifiers = "w900dp-h1100dp")
  fun expandedNavigationDrawer() = navigation(900, NavigationSuiteType.NavigationDrawer)

  @Test
  fun compactSupportingReplacesMainAndCloses() {
    show("supporting", 400)
    compose.onNodeWithTag("Supporting").assertIsDisplayed()
    compose.onNodeWithTag("Main").assertIsNotDisplayed()
    compose.onNodeWithTag("adaptive.close").performClick()
    compose.onNodeWithTag("Main").assertIsDisplayed()
    compose.onNodeWithTag("Supporting").assertIsNotDisplayed()
  }

  @Test
  @Config(qualifiers = "w900dp-h1100dp")
  fun expandedSupportingShowsBothAndCloses() {
    show("supporting", 900)
    compose.onNodeWithTag("Main").assertIsDisplayed()
    compose.onNodeWithTag("Supporting").assertIsDisplayed()
    compose.onNodeWithTag("adaptive.close").performClick()
    compose.onNodeWithTag("Main").assertIsDisplayed()
    compose.onNodeWithTag("Supporting").assertIsNotDisplayed()
  }

  @Test
  fun mediumNavigationUsesRail() {
    assertEquals(
      NavigationSuiteType.NavigationRail,
      adaptiveNavigationType(WindowSizeClass.compute(700f, 900f)),
    )
  }
}
