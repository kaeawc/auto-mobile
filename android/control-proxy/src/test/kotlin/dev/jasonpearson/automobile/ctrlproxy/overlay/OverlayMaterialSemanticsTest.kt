package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.AnnotatedString
import dev.jasonpearson.automobile.protocol.*
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowChoreographer

/** What observe and tapOn see for the last Material component slice (#10439). */
@RunWith(RobolectricTestRunner::class)
class OverlayMaterialSemanticsTest {
  private companion object {
    const val FRAME_INTERVAL_MS = 16L
    const val INFINITE_ANIMATION_SETTLE_MS = 200L
  }

  private val interactions = mutableListOf<OverlayInteraction>()
  private val save = listOf<OverlayAction>(OverlayEmitAction("save"))
  private val editing = OverlaySheetCondition("editing", true)
  private val saved = OverlaySheetCondition("saved", true)

  private fun render(
    root: OverlayNode,
    state: Map<String, OverlayScalar> = emptyMap(),
    hasInfiniteAnimation: Boolean = false,
  ): SemanticsNode {
    val spec = OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent { OverlaySpecContent(mapOverlaySpec(spec).root) { interactions += it } }
    // An indeterminate progress indicator reschedules a frame forever. Robolectric's Choreographer
    // posts each frame at the current virtual time, so idle() (and idleFor) never gets past it and
    // every frame appends to the ShadowTrace queue until the heap is gone (9 minutes, ~1 GB dump).
    // Give frames a real frame interval so a bounded idleFor ends.
    val looper = shadowOf(Looper.getMainLooper())
    if (hasInfiniteAnimation) {
      ShadowChoreographer.setPostFrameCallbackDelay(FRAME_INTERVAL_MS.toInt())
      looper.idleFor(Duration.ofMillis(INFINITE_ANIMATION_SETTLE_MS))
    } else looper.idle()
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

  private fun SemanticsNode.findTagged(tag: String): SemanticsNode? = find {
    it.config.contains(SemanticsProperties.TestTag) && it.config[SemanticsProperties.TestTag] == tag
  }

  private fun SemanticsNode.tagged(tag: String): SemanticsNode =
    checkNotNull(findTagged(tag)) { "no node tagged $tag" }

  private fun SemanticsNode.click() =
    assertEquals(true, checkNotNull(config[SemanticsActions.OnClick].action)())

  private fun SemanticsNode.description(): List<String> =
    config.getOrElse(SemanticsProperties.ContentDescription) { emptyList() }

  @Test
  fun `an icon button and a FAB are labelled Buttons that run their onTap`() {
    val root =
      render(
        OverlayColumnNode(
          children =
            listOf(
              OverlayIconButtonNode(testTag = "delete", icon = "delete", onTap = save),
              OverlayIconButtonNode(
                testTag = "edit",
                icon = "edit",
                variant = "outlined",
                contentDescription = "Edit alarm",
              ),
              OverlayFabNode(testTag = "add", icon = "add", label = "New alarm", onTap = save),
              OverlayFabNode(testTag = "small", icon = "add", size = "small"),
            ),
        ),
      )
    val delete = root.tagged("delete")
    assertEquals(Role.Button, delete.config[SemanticsProperties.Role])
    assertEquals(listOf("delete"), delete.description())
    assertEquals(listOf("Edit alarm"), root.tagged("edit").description())
    val add = root.tagged("add")
    assertEquals(Role.Button, add.config[SemanticsProperties.Role])
    assertEquals(listOf("New alarm"), add.description())
    assertEquals(listOf("add"), root.tagged("small").description())
    delete.click()
    add.click()
    root.tagged("small").click()
    assertEquals(listOf(OverlayInteraction.Tap(save), OverlayInteraction.Tap(save)), interactions)
  }

  @Test
  fun `each segment is a selectable tagged node and a tap chooses its value`() {
    val root =
      render(
        OverlaySegmentedButtonNode(
          testTag = "repeat",
          stateKey = "repeat",
          onTap = save,
          options =
            listOf(OverlayRadioOption("once", "Once"), OverlayRadioOption("daily", "Daily")),
        ),
        mapOf("repeat" to OverlayScalar.Text("once")),
      )
    val once = root.tagged("repeat.once")
    assertTrue(once.config[SemanticsProperties.Selected])
    assertEquals(listOf("Once"), once.description())
    val daily = root.tagged("repeat.daily")
    assertFalse(daily.config[SemanticsProperties.Selected])
    daily.click()
    assertEquals(listOf(OverlayInteraction.Choose("repeat", "daily", save)), interactions)
  }

  @Test
  fun `a top app bar reports its title and tags its navigation and action buttons`() {
    val root =
      render(
        OverlayTopAppBarNode(
          testTag = "bar",
          title = "Alarms",
          variant = "centerAligned",
          navigationIcon = OverlayAppBarAction("menu", "Menu", save),
          actions =
            listOf(
              OverlayAppBarAction("settings", "Settings"),
              OverlayAppBarAction("search", "Search", listOf(OverlayEmitAction("search"))),
            ),
        ),
      )
    val bar = root.tagged("bar")
    assertEquals(listOf(AnnotatedString("Alarms")), bar.config[SemanticsProperties.Text])
    assertEquals(listOf("Alarms"), bar.description())
    val menu = root.tagged("bar.navigation")
    assertEquals(listOf("Menu"), menu.description())
    assertEquals(Role.Button, menu.config[SemanticsProperties.Role])
    assertEquals(listOf("Settings"), root.tagged("bar.actions.0").description())
    menu.click()
    root.tagged("bar.actions.0").click()
    root.tagged("bar.actions.1").click()
    assertEquals(
      listOf(
        OverlayInteraction.Tap(save),
        OverlayInteraction.Tap(listOf(OverlayEmitAction("search"))),
      ),
      interactions,
    )
  }

  @Test
  fun `progress reports range info and a divider and badge report no kind label`() {
    val root =
      render(
        OverlayColumnNode(
          children =
            listOf(
              OverlayProgressNode(testTag = "upload", stateKey = "upload", max = 100.0),
              OverlayProgressNode(testTag = "busy", variant = "circular"),
              OverlayDividerNode(testTag = "line"),
              OverlayBadgeNode(testTag = "count", text = "3"),
            ),
        ),
        mapOf("upload" to OverlayScalar.Numeric(40.0)),
        hasInfiniteAnimation = true,
      )
    val upload = root.tagged("upload").config[SemanticsProperties.ProgressBarRangeInfo]
    assertEquals(0.4f, upload.current, 1e-6f)
    assertEquals(0f..1f, upload.range)
    assertEquals(
      ProgressBarRangeInfo.Indeterminate,
      root.tagged("busy").config[SemanticsProperties.ProgressBarRangeInfo],
    )
    assertTrue(root.tagged("line").description().isEmpty())
    assertEquals(listOf("3"), root.tagged("count").description())
  }

  @Test
  fun `an open dialog shows its title and text and its buttons close it`() {
    val dialog =
      OverlayDialogNode(
        testTag = "edit",
        openWhen = editing,
        title = "Edit alarm",
        text = "Set the time.",
        confirm = OverlayDialogButton("Save", save),
        dismiss = OverlayDialogButton("Cancel"),
        child = OverlayButtonNode(testTag = "inner", label = "Inner"),
      )
    val root = render(dialog, mapOf("editing" to OverlayScalar.BooleanValue(true)))
    val surface = root.tagged("edit")
    assertEquals(listOf("Edit alarm"), surface.description())
    assertTrue(
      root.find { node ->
        node.config
          .getOrElse(SemanticsProperties.Text) { emptyList() }
          .any {
            it.text == "Set the time."
          }
      } != null,
    )
    root.tagged("inner")
    root.tagged("edit.dismiss").click()
    root.tagged("edit.confirm").click()
    assertEquals(
      listOf(OverlayInteraction.CloseModal(editing), OverlayInteraction.CloseModal(editing, save)),
      interactions,
    )
  }

  @Test
  fun `a closed dialog draws nothing`() {
    val dialog =
      OverlayDialogNode(testTag = "edit", openWhen = editing, confirm = OverlayDialogButton("OK"))
    val root = render(dialog, mapOf("editing" to OverlayScalar.BooleanValue(false)))
    assertNull(root.findTagged("edit"))
    assertNull(root.findTagged("edit.confirm"))
  }

  @Test
  fun `an open snackbar shows its text and its action closes it`() {
    val root =
      render(
        OverlaySnackbarNode(
          testTag = "toast",
          openWhen = saved,
          text = "Alarm saved",
          action = OverlayDialogButton("Undo", save),
        ),
        mapOf("saved" to OverlayScalar.BooleanValue(true)),
      )
    assertEquals(listOf("Alarm saved"), root.tagged("toast").description())
    root.tagged("toast.action").click()
    assertEquals(listOf(OverlayInteraction.CloseModal(saved, save)), interactions)
  }

  @Test
  fun `time and date pickers report their bound value as state`() {
    val root =
      render(
        OverlayColumnNode(
          children =
            listOf(
              OverlayTimePickerNode(
                testTag = "time",
                hourKey = "hour",
                minuteKey = "minute",
                is24Hour = true,
              ),
              OverlayDatePickerNode(testTag = "date", stateKey = "date"),
            ),
        ),
        mapOf(
          "hour" to OverlayScalar.Numeric(7.0),
          "minute" to OverlayScalar.Numeric(30.0),
          "date" to OverlayScalar.Text("2026-10-08"),
        ),
      )
    assertEquals("07:30", root.tagged("time").config[SemanticsProperties.StateDescription])
    assertEquals("2026-10-08", root.tagged("date").config[SemanticsProperties.StateDescription])
    // Rendering the bound values must not report a change back.
    assertTrue(interactions.isEmpty())
  }
}
