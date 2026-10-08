package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.AnnotatedString
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** What observe and tapOn see for the Material component nodes (#10439). */
@RunWith(RobolectricTestRunner::class)
class OverlayComponentSemanticsTest {
  private val interactions = mutableListOf<OverlayInteraction>()
  private val save = listOf<OverlayAction>(OverlayEmitAction("save"))

  private fun render(): SemanticsNode {
    val spec =
      OverlaySpec(
        "panel",
        OverlayWindow(OverlayFullscreenPlacement()),
        mapOf(
          "alarm" to OverlayScalar.BooleanValue(true),
          "repeat" to OverlayScalar.BooleanValue(false),
          "volume" to OverlayScalar.Numeric(7.0),
          "mon" to OverlayScalar.BooleanValue(true),
          "tue" to OverlayScalar.BooleanValue(false),
        ),
        OverlayColumnNode(
          children =
            listOf(
              OverlaySwitchNode(testTag = "alarm", stateKey = "alarm", label = "Alarm"),
              OverlayCheckboxNode(testTag = "repeat", stateKey = "repeat", onTap = save),
              OverlayButtonNode(testTag = "save", label = "Save", onTap = save),
              OverlayButtonNode(testTag = "cancel", label = "Cancel", variant = "text"),
              OverlaySliderNode(
                testTag = "volume",
                stateKey = "volume",
                label = "Volume",
                min = 0.0,
                max = 10.0,
                step = 1.0,
              ),
              OverlayChipNode(testTag = "mon", label = "Mon", stateKey = "mon"),
              OverlayChipNode(testTag = "tue", label = "Tue", stateKey = "tue"),
              OverlayChipNode(testTag = "add", label = "Add", onTap = save),
              OverlayCardNode(
                testTag = "card",
                variant = "outlined",
                children = listOf(OverlayButtonNode(testTag = "inner", label = "Inner")),
              ),
            )
        ),
      )
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent { OverlaySpecContent(mapOverlaySpec(spec).root) { interactions += it } }
    shadowOf(Looper.getMainLooper()).idle()
    val view = checkNotNull(composeView(activity.window.decorView))
    return (view as RootForTest).semanticsOwner.rootSemanticsNode
  }

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull { composeView(view.getChildAt(it)) }
    else null

  private fun SemanticsNode.find(predicate: (SemanticsNode) -> Boolean): SemanticsNode? =
    if (predicate(this)) this else children.firstNotNullOfOrNull { it.find(predicate) }

  private fun SemanticsNode.tagged(tag: String): SemanticsNode =
    checkNotNull(
      find {
        it.config.contains(SemanticsProperties.TestTag) &&
          it.config[SemanticsProperties.TestTag] == tag
      }
    ) {
      "no node tagged $tag"
    }

  private fun SemanticsNode.click() =
    assertEquals(true, checkNotNull(config[SemanticsActions.OnClick].action)())

  @Test
  fun `a switch reports its role checked state and label and a tap toggles its key`() {
    val node = render().tagged("alarm")
    assertEquals(Role.Switch, node.config[SemanticsProperties.Role])
    assertEquals(ToggleableState.On, node.config[SemanticsProperties.ToggleableState])
    assertEquals(listOf(AnnotatedString("Alarm")), node.config[SemanticsProperties.Text])
    assertEquals(listOf("Alarm"), node.config[SemanticsProperties.ContentDescription])
    node.click()
    assertEquals(listOf(OverlayInteraction.Toggle("alarm")), interactions)
  }

  @Test
  fun `a checkbox toggles its key and carries its own actions`() {
    val node = render().tagged("repeat")
    assertEquals(Role.Checkbox, node.config[SemanticsProperties.Role])
    assertEquals(ToggleableState.Off, node.config[SemanticsProperties.ToggleableState])
    node.click()
    assertEquals(listOf(OverlayInteraction.Toggle("repeat", save)), interactions)
  }

  @Test
  fun `a button is one clickable Button node that runs its onTap once`() {
    val root = render()
    val node = root.tagged("save")
    assertEquals(Role.Button, node.config[SemanticsProperties.Role])
    assertEquals(listOf("Save"), node.config[SemanticsProperties.ContentDescription])
    assertFalse(node.config.contains(SemanticsProperties.ToggleableState))
    node.click()
    root.tagged("cancel").click()
    assertEquals(listOf(OverlayInteraction.Tap(save)), interactions)
  }

  @Test
  fun `a slider exposes its range info label and a set-progress action`() {
    val node = render().tagged("volume")
    val range = node.config[SemanticsProperties.ProgressBarRangeInfo]
    assertEquals(7f, range.current, 0f)
    assertEquals(0f..10f, range.range)
    assertEquals(9, range.steps)
    assertEquals(listOf(AnnotatedString("Volume")), node.config[SemanticsProperties.Text])
    assertEquals(listOf("Volume"), node.config[SemanticsProperties.ContentDescription])
    assertEquals(true, checkNotNull(node.config[SemanticsActions.SetProgress].action)(8f))
    assertEquals(listOf(OverlayInteraction.Slide("volume", 8.0)), interactions)
  }

  @Test
  fun `a filter chip reports checked state and toggles while an assist chip is a button`() {
    val root = render()
    val on = root.tagged("mon")
    assertEquals(Role.Checkbox, on.config[SemanticsProperties.Role])
    assertEquals(ToggleableState.On, on.config[SemanticsProperties.ToggleableState])
    assertEquals(listOf("Mon"), on.config[SemanticsProperties.ContentDescription])
    val off = root.tagged("tue")
    assertEquals(ToggleableState.Off, off.config[SemanticsProperties.ToggleableState])
    on.click()
    off.click()
    val assist = root.tagged("add")
    assertEquals(Role.Button, assist.config[SemanticsProperties.Role])
    assertFalse(assist.config.contains(SemanticsProperties.ToggleableState))
    assist.click()
    assertEquals(
      listOf(
        OverlayInteraction.Toggle("mon"),
        OverlayInteraction.Toggle("tue"),
        OverlayInteraction.Tap(save),
      ),
      interactions,
    )
  }

  @Test
  fun `a card is a semantics-free container that keeps its children reachable`() {
    val card = render().tagged("card")
    assertFalse(card.config.contains(SemanticsProperties.ContentDescription))
    assertEquals(Role.Button, card.tagged("inner").config[SemanticsProperties.Role])
  }
}
