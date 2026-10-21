package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PrototypeMenusSemanticsTest {
  @get:Rule val compose = createComposeRule()
  private val interactions = mutableListOf<PrototypeInteraction>()
  private val condition = PrototypeSheetCondition("open", true)
  private val go = listOf<PrototypeAction>(PrototypeEmitAction("go"))

  private fun show(node: PrototypeNode, open: Boolean = true) {
    val spec =
      PrototypeSpec(
        "menus",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("open" to PrototypeScalar.BooleanValue(open), "choice" to PrototypeScalar.Text("a")),
        PrototypeColumnNode(
          testTag = "parent",
          children = listOf(node),
          style =
            PrototypeStyle(
              width = PrototypeDimension.Dp(220.0),
              height = PrototypeDimension.Dp(80.0),
            ),
        ),
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

  private fun menu() =
    PrototypeMenuNode(
      testTag = "menu",
      openWhen = condition,
      items =
        listOf(
          PrototypeMenuEntry("Go", onTap = go),
          PrototypeMenuDivider,
          PrototypeMenuEntry("Unavailable", enabled = false),
        ),
    )

  private fun select() =
    PrototypeSelectNode(
      testTag = "choice",
      stateKey = "choice",
      label = "Choice",
      onTap = go,
      options = listOf(PrototypeRadioOption("a", "Alpha"), PrototypeRadioOption("b", "Beta")),
    )

  @Test
  fun `open menu exposes stable index tags and disabled rows have no click action`() {
    show(menu())
    compose.onNodeWithTag("menu.0").assertTextEquals("Go").assertHasClickAction().performClick()
    assertEquals(listOf(PrototypeInteraction.CloseModal(condition, go)), interactions)
    compose
      .onNodeWithTag("menu.2")
      .assertTextEquals("Unavailable")
      .assertIsNotEnabled()
      .assertHasNoClickAction()
    compose.onNodeWithTag("menu.1").assertDoesNotExist()
  }

  @Test
  fun `a disabled menu row consumes taps without closing`() {
    show(menu())
    compose.onNodeWithTag("menu.2").performTouchInput { click() }
    compose.waitForIdle()
    assertTrue(interactions.isEmpty())
  }

  @Test
  fun `outside requests the same close as dialog dismiss`() {
    show(menu())
    compose.onNodeWithTag("menu:outside").performClick()
    assertEquals(listOf(PrototypeInteraction.SheetDismiss(condition)), interactions)
  }

  @Test
  fun `closed menu exposes no surface or items`() {
    show(menu(), open = false)
    compose.onNodeWithTag("menu").assertDoesNotExist()
    compose.onNodeWithTag("menu.0").assertDoesNotExist()
    compose.onNodeWithTag("menu:outside").assertDoesNotExist()
  }

  @Test
  fun `an open menu hides page nodes and closing restores them`() {
    val open = mutableStateOf(true)
    val spec =
      PrototypeSpec(
        "menus",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root =
          PrototypeColumnNode(
            children = listOf(PrototypeButtonNode(testTag = "page", label = "Page"), menu()),
          ),
      )
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotion provides false) {
        val shown = spec.copy(state = mapOf("open" to PrototypeScalar.BooleanValue(open.value)))
        PrototypeSpecContent(mapPrototypeSpec(shown).root) {
          interactions += it
          if (it == PrototypeInteraction.SheetDismiss(condition)) open.value = false
        }
      }
    }
    compose.onNodeWithTag("page").assertDoesNotExist()
    compose.onNodeWithTag("menu.0").assertExists()
    compose.onNodeWithTag("menu:outside").assertHasClickAction().performClick()
    compose.onNodeWithTag("page").assertExists().assertHasClickAction()
    compose.onNodeWithTag("menu.0").assertDoesNotExist()
  }

  @Test
  fun `menu starts at its parent bottom and remains inside the window`() {
    show(menu())
    val parent =
      compose.onNodeWithTag("parent", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
    val surface = compose.onNodeWithTag("menu").fetchSemanticsNode().boundsInRoot
    val window = compose.onRoot().fetchSemanticsNode().boundsInRoot
    assertEquals(parent.bottom, surface.top, 1f)
    assertTrue(surface.left >= window.left && surface.right <= window.right)
    assertTrue(surface.bottom <= window.bottom)
  }

  @Test
  fun `select shows the current label expands and choosing emits Choose then collapses`() {
    show(select())
    compose.onNodeWithTag("choice").assertTextContains("Alpha").performClick()
    compose.onNodeWithTag("parent").assertExists()
    compose.onNodeWithTag("choice.a").assertTextEquals("Alpha").assertIsSelected()
    compose.onNodeWithTag("choice.b").assertTextEquals("Beta").performClick()
    assertEquals(listOf(PrototypeInteraction.Choose("choice", "b", go)), interactions)
    compose.onNodeWithTag("choice.b").assertDoesNotExist()
  }

  @Test
  fun `select closes when its field is tapped again or outside is tapped`() {
    show(select())
    compose.onNodeWithTag("choice").performClick()
    compose.onNodeWithTag("choice.b").assertExists()
    compose.onNodeWithTag("choice").performClick()
    compose.onNodeWithTag("choice.b").assertDoesNotExist()
    compose.onNodeWithTag("choice").performClick()
    compose.onNodeWithTag("choice:outside").performClick()
    compose.onNodeWithTag("choice.b").assertDoesNotExist()
    assertTrue(interactions.isEmpty())
  }
}
