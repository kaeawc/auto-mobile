package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * An open dialog is modal: the page behind it is out of the accessibility tree (#10912), like iOS
 * and like touches. A snackbar is not modal and leaves the page in.
 */
@RunWith(RobolectricTestRunner::class)
class PrototypeDialogPageSemanticsTest {
  @get:Rule val compose = createComposeRule()

  private val open = PrototypeSheetCondition("open", true)

  private fun show(modal: PrototypeNode, isOpen: Boolean) {
    val spec =
      PrototypeSpec(
        "panel",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("open" to PrototypeScalar.BooleanValue(isOpen)),
        PrototypeColumnNode(
          children = listOf(PrototypeButtonNode(testTag = "page", label = "Page"), modal),
        ),
      )
    compose.setContent { PrototypeSpecContent(mapPrototypeSpec(spec).root) {} }
    compose.waitForIdle()
  }

  private fun count(tag: String, unmerged: Boolean = false): Int =
    compose.onAllNodesWithTag(tag, useUnmergedTree = unmerged).fetchSemanticsNodes().size

  private fun dialog() =
    PrototypeDialogNode(testTag = "dlg", openWhen = open, confirm = PrototypeDialogButton("OK"))

  private fun snackbar() = PrototypeSnackbarNode(testTag = "toast", openWhen = open, text = "Saved")

  @Test
  fun `an open dialog removes the page from the accessibility tree and keeps its own buttons`() {
    show(dialog(), isOpen = true)
    assertEquals(0, count("page"))
    assertEquals(1, count("dlg.confirm"))
  }

  @Test
  fun `a closed dialog leaves the page in the accessibility tree`() {
    show(dialog(), isOpen = false)
    assertEquals(1, count("page"))
  }

  @Test
  fun `an open snackbar leaves the page in the accessibility tree`() {
    show(snackbar(), isOpen = true)
    assertEquals(1, count("page"))
    assertEquals(1, count("toast"))
  }
}
