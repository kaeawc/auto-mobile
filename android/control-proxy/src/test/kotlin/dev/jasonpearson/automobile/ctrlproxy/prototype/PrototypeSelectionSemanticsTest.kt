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

/** What observe and tapOn see for `radioGroup`, `listItem` and the button extras (#10439). */
@RunWith(RobolectricTestRunner::class)
class OverlaySelectionSemanticsTest {
  private val interactions = mutableListOf<OverlayInteraction>()
  private val go = listOf<OverlayAction>(OverlayEmitAction("go"))

  private fun render(): SemanticsNode {
    val spec =
      OverlaySpec(
        "panel",
        OverlayWindow(OverlayFullscreenPlacement()),
        mapOf(
          "sound" to OverlayScalar.Text("beep"),
          "sync" to OverlayScalar.BooleanValue(true),
          "wifi" to OverlayScalar.BooleanValue(false),
        ),
        OverlayColumnNode(
          children =
            listOf(
              OverlayRadioGroupNode(
                testTag = "sound",
                stateKey = "sound",
                onTap = go,
                options =
                  listOf(OverlayRadioOption("chime", "Chime"), OverlayRadioOption("beep", "Beep")),
              ),
              OverlayListItemNode(
                testTag = "sync",
                headline = "Sync",
                supporting = "Across devices",
                leadingIcon = "refresh",
                trailing = OverlayListItemSwitch("sync"),
                onTap = go,
              ),
              OverlayListItemNode(
                testTag = "wifi",
                headline = "Wi-Fi only",
                trailing = OverlayListItemCheckbox("wifi"),
              ),
              OverlayListItemNode(
                testTag = "advanced",
                headline = "Advanced",
                trailing = OverlayListItemIcon("chevron_right"),
                onTap = go,
              ),
              OverlayListItemNode(testTag = "about", headline = "About"),
              OverlayButtonNode(
                testTag = "save",
                label = "Save",
                variant = "tonal",
                icon = "check",
                onTap = go,
              ),
              OverlayButtonNode(testTag = "share", label = "Share", variant = "elevated"),
            ),
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
      },
    ) {
      "no node tagged $tag"
    }

  private fun SemanticsNode.click() =
    assertEquals(true, checkNotNull(config[SemanticsActions.OnClick].action)())

  @Test
  fun `each radio option is a RadioButton with its label and selected state`() {
    val root = render()
    val chime = root.tagged("sound.chime")
    val beep = root.tagged("sound.beep")
    assertEquals(Role.RadioButton, chime.config[SemanticsProperties.Role])
    assertEquals(listOf(AnnotatedString("Chime")), chime.config[SemanticsProperties.Text])
    assertEquals(false, chime.config[SemanticsProperties.Selected])
    assertEquals(true, beep.config[SemanticsProperties.Selected])
    chime.click()
    assertEquals(listOf(OverlayInteraction.Choose("sound", "chime", go)), interactions)
  }

  @Test
  fun `a list item with a trailing switch is one toggleable Switch node`() {
    val node = render().tagged("sync")
    assertEquals(Role.Switch, node.config[SemanticsProperties.Role])
    assertEquals(ToggleableState.On, node.config[SemanticsProperties.ToggleableState])
    assertEquals(
      listOf(AnnotatedString("Sync"), AnnotatedString("Across devices")),
      node.config[SemanticsProperties.Text],
    )
    node.click()
    assertEquals(listOf(OverlayInteraction.Toggle("sync", go)), interactions)
  }

  @Test
  fun `a list item with a trailing checkbox reports the Checkbox role and checked state`() {
    val node = render().tagged("wifi")
    assertEquals(Role.Checkbox, node.config[SemanticsProperties.Role])
    assertEquals(ToggleableState.Off, node.config[SemanticsProperties.ToggleableState])
    node.click()
    assertEquals(listOf(OverlayInteraction.Toggle("wifi")), interactions)
  }

  @Test
  fun `a tappable list item is a Button and a plain one is not clickable`() {
    val root = render()
    val advanced = root.tagged("advanced")
    assertEquals(Role.Button, advanced.config[SemanticsProperties.Role])
    assertFalse(advanced.config.contains(SemanticsProperties.ToggleableState))
    advanced.click()
    assertEquals(listOf(OverlayInteraction.Tap(go)), interactions)
    assertFalse(root.tagged("about").config.contains(SemanticsActions.OnClick))
  }

  @Test
  fun `tonal and elevated buttons stay single clickable Button nodes`() {
    val root = render()
    val save = root.tagged("save")
    assertEquals(Role.Button, save.config[SemanticsProperties.Role])
    assertEquals(listOf("Save"), save.config[SemanticsProperties.ContentDescription])
    assertEquals(Role.Button, root.tagged("share").config[SemanticsProperties.Role])
    save.click()
    assertEquals(listOf(OverlayInteraction.Tap(go)), interactions)
  }
}
