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

@RunWith(RobolectricTestRunner::class)
class PrototypeTooltipSemanticsTest {
  @get:Rule val compose = createComposeRule()
  private val interactions = mutableListOf<PrototypeInteraction>()
  private val condition = PrototypeSheetCondition("open", true)
  private val actions = listOf<PrototypeAction>(PrototypeEmitAction("next"))

  private fun show(
    spotlight: Boolean = false,
    onTap: List<PrototypeAction>? = null,
    anchorTo: String = "target",
    targetVisible: Boolean = true,
  ) {
    val spec =
      PrototypeSpec(
        "tooltip",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf(
          "open" to PrototypeScalar.BooleanValue(true),
          "visible" to PrototypeScalar.BooleanValue(targetVisible),
        ),
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeButtonNode(
                id = "target",
                testTag = "target",
                label = "Help",
                visibleWhen = PrototypeCondition("visible", PrototypeScalar.BooleanValue(true)),
              ),
              PrototypeTooltipNode(
                testTag = "tip",
                text = "Helpful hint",
                anchorTo = anchorTo,
                openWhen = condition,
                spotlight = if (spotlight) PrototypeTooltipSpotlight() else null,
                onDismiss = actions,
                onTap = onTap,
              ),
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

  @Test
  fun textExposedWithTag() {
    show()
    compose.onNodeWithTag("tip").assertTextEquals("Helpful hint")
    compose.onNodeWithTag("target").assertExists()
    compose.onNodeWithTag("tip.close").assertDoesNotExist()
  }

  @Test
  fun bubbleDismissesWithOnDismissActions() {
    show()
    compose.onNodeWithTag("tip").performClick()
    assertEquals(listOf(PrototypeInteraction.CloseModal(condition, actions)), interactions)
  }

  @Test
  fun onTapRunsWithoutClosing() {
    show(onTap = actions)
    compose.onNodeWithTag("tip").performClick()
    assertEquals(listOf(PrototypeInteraction.Tap(actions)), interactions)
  }

  @Test
  fun spotlightHidesPageAndScrimDismisses() {
    show(spotlight = true)
    compose.onNodeWithTag("target").assertDoesNotExist()
    compose.onNodeWithTag("tip").assertTextEquals("Helpful hint")
    compose.onNodeWithTag("tip.close").performClick()
    assertEquals(listOf(PrototypeInteraction.CloseModal(condition, actions)), interactions)
  }

  @Test
  fun missingTargetDrawsNothing() {
    show(spotlight = true, anchorTo = "missing")
    compose.onNodeWithTag("tip").assertDoesNotExist()
    compose.onNodeWithTag("tip.close").assertDoesNotExist()
    assertTrue(interactions.isEmpty())
  }

  @Test
  fun unlaidOutTargetDrawsNothing() {
    show(spotlight = true, targetVisible = false)
    compose.onNodeWithTag("tip").assertDoesNotExist()
    compose.onNodeWithTag("tip.close").assertDoesNotExist()
  }
}
