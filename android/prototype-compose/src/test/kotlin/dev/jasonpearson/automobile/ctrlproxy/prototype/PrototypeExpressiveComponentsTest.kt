package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Material 3 Expressive variants drawn from stable Compose primitives (#15258). */
@RunWith(RobolectricTestRunner::class)
class PrototypeExpressiveComponentsTest {
  @get:Rule val compose = createComposeRule()

  private val interactions = mutableListOf<PrototypeInteraction>()

  private fun model(root: PrototypeNode, state: Map<String, PrototypeScalar> = emptyMap()) =
    mapPrototypeSpec(
        PrototypeSpec("expressive", PrototypeWindow(PrototypeFullscreenPlacement()), state, root),
      )
      .root

  private fun render(motion: Boolean, content: @androidx.compose.runtime.Composable () -> Unit) {
    compose.setContent {
      CompositionLocalProvider(LocalPrototypeMotion provides motion) { MaterialTheme { content() } }
    }
  }

  private val fab =
    PrototypeFabNode(
      testTag = "create",
      icon = "add",
      contentDescription = "Create",
      menu =
        PrototypeFabMenu(
          listOf(
            PrototypeFabMenuItem("edit", "Note", listOf(PrototypeEmitAction("note"))),
            PrototypeFabMenuItem("image", "Photo", listOf(PrototypeEmitAction("photo"))),
            PrototypeFabMenuItem("mic", "Voice", listOf(PrototypeEmitAction("voice"))),
          ),
        ),
    )

  @Test
  fun `connected selection morphs the inner corner on the expressive spring`() {
    var selected by mutableStateOf(false)
    var corner = 0.dp
    render(motion = true) { corner = animatePrototypeConnectedCorner(selected).value }
    compose.waitForIdle()
    assertEquals(PROTOTYPE_CONNECTED_INNER_CORNER, corner)
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      selected = true
      Snapshot.sendApplyNotifications()
    }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    assertTrue("corner $corner is mid-morph", corner > PROTOTYPE_CONNECTED_INNER_CORNER)
    assertTrue("corner $corner is mid-morph", corner < PROTOTYPE_CONNECTED_FULL_CORNER)
    compose.mainClock.advanceTimeBy(2_000)
    assertEquals(PROTOTYPE_CONNECTED_FULL_CORNER.value, corner.value, 0.01f)
  }

  @Test
  fun `connected selection snaps when motion is off`() {
    var selected by mutableStateOf(false)
    var corner: Dp = 0.dp
    render(motion = false) { corner = animatePrototypeConnectedCorner(selected).value }
    compose.waitForIdle()
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      selected = true
      Snapshot.sendApplyNotifications()
    }
    // Recomposition, then the snap: two frames, far short of the spring's settle time.
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(PROTOTYPE_CONNECTED_FULL_CORNER, corner)
  }

  @Test
  fun `connected segments are radio options that choose their value`() {
    val node =
      model(
        PrototypeSegmentedButtonNode(
          testTag = "mode",
          stateKey = "mode",
          variant = "connected",
          options =
            listOf(PrototypeRadioOption("day", "Day"), PrototypeRadioOption("week", "Week")),
        ),
        mapOf("mode" to PrototypeScalar.Text("day")),
      )
    render(motion = false) { RenderPrototypeSegmentedButton(node, Modifier) { interactions += it } }
    compose.onNodeWithTag("mode.day").assertIsSelected()
    compose.onNodeWithTag("mode.week").performClick()
    assertEquals(PrototypeInteraction.Choose("mode", "week", emptyList()), interactions.single())
  }

  @Test
  fun `fab menu expansion runs on the expressive spring`() {
    var open by mutableStateOf(false)
    var expansion = -1f
    render(motion = true) { expansion = animatePrototypeMenuExpansion(open).value }
    compose.waitForIdle()
    assertEquals(0f, expansion)
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      open = true
      Snapshot.sendApplyNotifications()
    }
    repeat(3) { compose.mainClock.advanceTimeByFrame() }
    assertTrue("expansion $expansion is mid-flight", expansion > 0f && expansion < 1f)
    compose.mainClock.advanceTimeBy(2_000)
    assertEquals(1f, expansion, 0.01f)
  }

  @Test
  fun `fab menu is mid-expansion one frame after the tap and tags its items by index`() {
    val node = model(fab)
    render(motion = true) {
      RenderPrototypeFab(node, Modifier.testTag("create")) { interactions += it }
    }
    compose.onNodeWithTag("create.items.0").assertDoesNotExist()
    compose.mainClock.autoAdvance = false
    compose.onNodeWithTag("create").performClick()
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    for (index in 0..2) compose.onNodeWithTag("create.items.$index").assertExists()
    compose.mainClock.advanceTimeBy(2_000)
    compose.onNodeWithTag("create.items.2").assertExists()
    assertTrue(interactions.isEmpty())
  }

  @Test
  fun `fab menu items run their actions and close the menu`() {
    val node = model(fab)
    render(motion = false) {
      RenderPrototypeFab(node, Modifier.testTag("create")) { interactions += it }
    }
    compose.onNodeWithTag("create").performClick()
    for (index in 0..2) compose.onNodeWithTag("create.items.$index").assertExists()
    compose.onNodeWithTag("create.items.1").performClick()
    assertEquals(
      PrototypeInteraction.Tap(listOf(PrototypeEmitAction("photo"))),
      interactions.single(),
    )
    compose.onNodeWithTag("create.items.1").assertDoesNotExist()
  }

  @Test
  fun `split button runs its leading action and opens its menu from the trailing half`() {
    val node =
      model(
        PrototypeButtonNode(
          testTag = "send",
          label = "Send",
          onTap = listOf(PrototypeEmitAction("send")),
          split =
            PrototypeButtonSplit(
              listOf(
                PrototypeMenuEntry("Schedule", onTap = listOf(PrototypeEmitAction("schedule"))),
                PrototypeMenuDivider,
                PrototypeMenuEntry("Draft", onTap = listOf(PrototypeEmitAction("draft"))),
              ),
            ),
        ),
      )
    render(motion = false) { RenderPrototypeButton(node, Modifier) { interactions += it } }
    compose.onNodeWithTag("send.menu.0").assertDoesNotExist()
    compose.onNodeWithTag("send.menu").performClick()
    compose.onNodeWithTag("send.menu.2").performClick()
    assertEquals(
      PrototypeInteraction.Tap(listOf(PrototypeEmitAction("draft"))),
      interactions.last(),
    )
    compose.onNodeWithTag("send.menu.2").assertDoesNotExist()
  }

  @Test
  fun `split button leading half is a labelled control that runs the leading action`() {
    val node =
      model(
        PrototypeButtonNode(
          testTag = "send",
          label = "Send",
          onTap = listOf(PrototypeEmitAction("send")),
          split = PrototypeButtonSplit(listOf(PrototypeMenuEntry("Draft"))),
        ),
      )
    render(motion = false) { RenderPrototypeButton(node, Modifier) { interactions += it } }
    compose.onNode(hasContentDescription("Send") and hasClickAction()).performClick()
    assertEquals(
      PrototypeInteraction.Tap(listOf(PrototypeEmitAction("send"))),
      interactions.single(),
    )
  }

  @Test
  fun `reduced profile snaps the selection morph and rests the indicator loops`() {
    var selected by mutableStateOf(false)
    var corner = 0.dp
    var loops = true
    render(motion = true) {
      CompositionLocalProvider(
        LocalPrototypeMotionProfile provides PrototypeMotionProfile.REDUCED,
      ) {
        corner = animatePrototypeConnectedCorner(selected).value
        loops = prototypeExpressiveLoops()
      }
    }
    compose.waitForIdle()
    assertFalse(loops)
    compose.mainClock.autoAdvance = false
    compose.runOnUiThread {
      selected = true
      Snapshot.sendApplyNotifications()
    }
    repeat(2) { compose.mainClock.advanceTimeByFrame() }
    assertEquals(PROTOTYPE_CONNECTED_FULL_CORNER, corner)
  }

  @Test
  fun `full motion keeps the indicator loops running`() {
    var loops = false
    render(motion = true) { loops = prototypeExpressiveLoops() }
    compose.waitForIdle()
    assertTrue(loops)
  }

  @Test
  fun `labelled fab keeps its label when it has a menu`() {
    val node = model(fab.copy(label = "New", contentDescription = null))
    render(motion = false) {
      RenderPrototypeFab(node, Modifier.testTag("create")) { interactions += it }
    }
    compose.onNode(hasContentDescription("New") and hasClickAction()).performClick()
    compose.onNodeWithTag("create.items.0").assertExists()
  }

  @Test
  fun `wavy progress reports its fraction and the loading indicator is indeterminate`() {
    val wavy =
      model(
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeProgressNode(testTag = "wavy", variant = "wavy", stateKey = "p", max = 4.0),
              PrototypeLoadingIndicatorNode(testTag = "loading", contained = true),
            ),
        ),
        mapOf("p" to PrototypeScalar.Numeric(1.0)),
      )
    render(motion = false) {
      RenderPrototypeProgress(wavy.children[0], Modifier.testTag("wavy"))
      RenderPrototypeLoadingIndicator(wavy.children[1], Modifier.testTag("loading"))
    }
    compose
      .onNodeWithTag("wavy")
      .assert(
        SemanticsMatcher.expectValue(
          SemanticsProperties.ProgressBarRangeInfo,
          ProgressBarRangeInfo(0.25f, 0f..1f),
        ),
      )
    compose
      .onNodeWithTag("loading")
      .assert(
        SemanticsMatcher.expectValue(
          SemanticsProperties.ProgressBarRangeInfo,
          ProgressBarRangeInfo.Indeterminate,
        ),
      )
  }

  @Test
  fun `wave and lobed paths stay inside their bounds`() {
    val wave = prototypeWavePath(0f, 200f, 10f, PrototypeWave(3f, 40f, 0.25f)).getBounds()
    assertTrue(wave.top >= 7f - 0.01f && wave.bottom <= 13f + 0.01f)
    assertEquals(0f, wave.left, 0.01f)
    val lobes = prototypeLobedPath(50f, 7, 0.1f, Offset(50f, 50f)).getBounds()
    assertTrue(lobes.left >= -0.01f && lobes.right <= 100.01f)
    assertTrue(lobes.top >= -0.01f && lobes.bottom <= 100.01f)
  }
}
