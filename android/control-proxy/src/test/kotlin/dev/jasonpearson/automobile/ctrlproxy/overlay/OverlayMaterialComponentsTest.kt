package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

/** Device-free mapping and runtime behaviour of the last Material component slice (#10439). */
class OverlayMaterialComponentsTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      OverlaySpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<OverlayEvent>()
  private var sequence = 0L
  private val open = OverlaySheetCondition("open", true)

  private fun spec(root: OverlayNode, state: Map<String, OverlayScalar>) =
    OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), state, root)

  private fun runtime(spec: OverlaySpec) =
    OverlayRuntime(spec, { events += it }, { 42L }, { ++sequence })

  private fun dialog(child: OverlayNode? = null) =
    OverlayDialogNode(
      openWhen = open,
      title = "Delete {name}?",
      text = "{name} goes away.",
      confirm = OverlayDialogButton("Delete", listOf(OverlayEmitAction("delete"))),
      dismiss = OverlayDialogButton("Cancel"),
      child = child,
    )

  @Test
  fun `each new node maps its role label and bound state`() {
    val state =
      mapOf(
        "open" to OverlayScalar.BooleanValue(true),
        "name" to OverlayScalar.Text("Wake"),
        "mode" to OverlayScalar.Text("b"),
        "upload" to OverlayScalar.Numeric(30.0),
        "hour" to OverlayScalar.Numeric(7.0),
        "minute" to OverlayScalar.Numeric(5.0),
        "date" to OverlayScalar.Text("2026-10-08"),
      )
    val root =
      mapOverlaySpec(
          spec(
            OverlayColumnNode(
              children =
                listOf(
                  OverlayIconButtonNode(icon = "delete"),
                  OverlayFabNode(icon = "add", label = "New"),
                  OverlaySegmentedButtonNode(
                    stateKey = "mode",
                    options = listOf(OverlayRadioOption("a", "A"), OverlayRadioOption("b", "B")),
                  ),
                  OverlayTopAppBarNode(title = "Hi {name}"),
                  OverlayDividerNode(),
                  OverlayBadgeNode(text = "3"),
                  OverlayProgressNode(stateKey = "upload", max = 100.0),
                  dialog(),
                  OverlaySnackbarNode(openWhen = open, text = "Saved {name}"),
                  OverlayTimePickerNode(hourKey = "hour", minuteKey = "minute"),
                  OverlayDatePickerNode(stateKey = "date"),
                ),
            ),
            state,
          ),
        )
        .root
    val nodes = root.children
    assertEquals(
      listOf(
        "iconButton",
        "fab",
        "segmentedButton",
        "topAppBar",
        "divider",
        "badge",
        "progress",
        "dialog",
        "snackbar",
        "timePicker",
        "datePicker",
      ),
      nodes.map { it.role },
    )
    assertEquals(
      listOf("", "New", "", "Hi Wake", "", "3", "", "Delete Wake?", "Saved Wake", "", ""),
      nodes.map { it.text },
    )
    assertEquals("delete", nodes[0].iconName)
    assertEquals("b", nodes[2].selectedValue)
    assertEquals(30.0, nodes[6].sliderValue, 0.0)
    assertEquals("Wake goes away.", nodes[7].supportingText)
    assertTrue(nodes[7].sheetOpen)
    assertTrue(nodes[8].sheetOpen)
    assertEquals(7 to 5, nodes[9].hour to nodes[9].minute)
    assertEquals("07:05", overlayPickerValue(nodes[9]))
    assertEquals("2026-10-08", overlayPickerValue(nodes[10]))
    assertEquals("07:05", overlayStateDescription("timePicker", 0, 0, "07:05"))
    assertNull(overlayStateDescription("progress", 0, 0, "07:05"))
    assertEquals(listOf("dialog", "snackbar"), modalOverlaySheets(root).map { it.role })
  }

  @Test
  fun `an icon control is labelled by its icon unless a label or description is authored`() {
    assertEquals("delete", overlayContentDescription("iconButton", "", "delete", tappable = false))
    assertEquals("New", overlayContentDescription("fab", "New", "add", tappable = false))
    assertEquals(
      "Remove",
      overlayContentDescription("iconButton", "", "delete", tappable = false, authored = "Remove"),
    )
  }

  @Test
  fun `a closed dialog is not hoisted and its text field does not take focus`() {
    val field = OverlayTextFieldNode(stateKey = "name")
    val closed =
      mapOverlaySpec(
          spec(
            dialog(field),
            mapOf("open" to OverlayScalar.BooleanValue(false), "name" to OverlayScalar.Text("")),
          ),
        )
        .root
    assertTrue(modalOverlaySheets(closed).isEmpty())
    assertFalse(hasVisibleTextField(closed))
    val shown =
      mapOverlaySpec(
          spec(
            dialog(field),
            mapOf("open" to OverlayScalar.BooleanValue(true), "name" to OverlayScalar.Text("")),
          ),
        )
        .root
    assertTrue(hasVisibleTextField(shown))
    assertEquals("root.child", shown.children.single().identity)
  }

  @Test
  fun `a dialog button closes the dialog emits change then runs its actions`() = runTest {
    val runtime = runtime(spec(dialog(), mapOf("open" to OverlayScalar.BooleanValue(true))))
    runtime.handle(OverlayInteraction.CloseModal(open, listOf(OverlayEmitAction("delete"))))
    assertEquals(OverlayScalar.BooleanValue(false), runtime.current.state["open"])
    assertEquals(listOf("change", "delete"), events.map { it.name })
  }

  @Test
  fun `closing an already closed dialog still runs the button actions but emits no change`() =
    runTest {
      val runtime = runtime(spec(dialog(), mapOf("open" to OverlayScalar.BooleanValue(false))))
      runtime.handle(OverlayInteraction.CloseModal(open, listOf(OverlayEmitAction("delete"))))
      assertEquals(listOf("delete"), events.map { it.name })
    }

  @Test
  fun `a time change stores both keys in one change event then runs actions`() = runTest {
    val runtime =
      runtime(
        spec(
          OverlayTimePickerNode(hourKey = "hour", minuteKey = "minute"),
          mapOf("hour" to OverlayScalar.Numeric(7.0), "minute" to OverlayScalar.Numeric(30.0)),
        ),
      )
    runtime.handle(
      OverlayInteraction.SetTime("hour", "minute", 8, 45, listOf(OverlayEmitAction("time"))),
    )
    assertEquals(OverlayScalar.Numeric(8.0), runtime.current.state["hour"])
    assertEquals(OverlayScalar.Numeric(45.0), runtime.current.state["minute"])
    assertEquals(listOf("change", "time"), events.map { it.name })
    assertEquals(
      buildJsonObject {
        put(
          "keys",
          buildJsonArray {
            add("hour")
            add("minute")
          },
        )
        put(
          "values",
          buildJsonObject {
            put("hour", 8.0)
            put("minute", 45.0)
          },
        )
      },
      events.first().payload,
    )
    runtime.handle(OverlayInteraction.SetTime("hour", "minute", 8, 50))
    assertEquals(
      buildJsonObject {
        put("key", "minute")
        put("value", 50.0)
      },
      events.last().payload,
    )
    runtime.handle(OverlayInteraction.SetTime("hour", "minute", 8, 50))
    assertEquals(3, events.size)
  }

  @Test
  fun `a time change outside the picker range is rejected by the validator`() = runTest {
    val runtime =
      runtime(
        spec(
          OverlayTimePickerNode(hourKey = "hour", minuteKey = "minute"),
          mapOf("hour" to OverlayScalar.Numeric(7.0), "minute" to OverlayScalar.Numeric(30.0)),
        ),
      )
    val error = runCatching { runtime.handle(OverlayInteraction.SetTime("hour", "minute", 24, 0)) }
    assertTrue("$error", error.exceptionOrNull() is IllegalArgumentException)
    assertEquals(OverlayScalar.Numeric(7.0), runtime.current.state["hour"])
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a time change on keys that are not numbers is inert`() = runTest {
    val runtime = runtime(spec(OverlaySpacerNode(), mapOf("hour" to OverlayScalar.Text("7"))))
    runtime.handle(OverlayInteraction.SetTime("hour", "minute", 8, 0))
    assertEquals(OverlayScalar.Text("7"), runtime.current.state["hour"])
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a picked date binds the string key like a radio choice`() = runTest {
    val runtime =
      runtime(
        spec(
          OverlayDatePickerNode(stateKey = "date"),
          mapOf("date" to OverlayScalar.Text("2026-10-08")),
        ),
      )
    runtime.handle(OverlayInteraction.Choose("date", "2026-12-25"))
    assertEquals(OverlayScalar.Text("2026-12-25"), runtime.current.state["date"])
    val error = runCatching { runtime.handle(OverlayInteraction.Choose("date", "2026-13-01")) }
    assertTrue("$error", error.exceptionOrNull() is IllegalArgumentException)
  }

  @Test
  fun `dates convert to and from the picker's UTC midnight`() {
    val millis = checkNotNull(overlayDateMillis("2024-02-29"))
    assertEquals(1709164800000L, millis)
    assertEquals("2024-02-29", overlayDateString(millis))
    assertEquals("1900-01-01", overlayDateString(checkNotNull(overlayDateMillis("1900-01-01"))))
    assertNull(overlayDateMillis(null))
    assertNull(overlayDateMillis("2024-02"))
  }

  @Test
  fun `the validator accepts only real dates in the picker year range`() {
    assertTrue(OverlaySpecValidator.isOverlayDate("2024-02-29"))
    assertFalse(OverlaySpecValidator.isOverlayDate("2023-02-29"))
    assertFalse(OverlaySpecValidator.isOverlayDate("2100-02-29"))
    assertTrue(OverlaySpecValidator.isOverlayDate("2000-02-29"))
    assertFalse(OverlaySpecValidator.isOverlayDate("2101-01-01"))
    assertFalse(OverlaySpecValidator.isOverlayDate("2026-1-01"))
  }

  @Test
  fun `a determinate progress draws its value over max`() {
    assertEquals(0.3f, overlayProgressFraction(30.0, 100.0), 1e-6f)
    assertEquals(0.4f, overlayProgressFraction(0.4, null), 1e-6f)
    assertEquals(1f, overlayProgressFraction(2.0, null), 0f)
  }

  @Test
  fun `a dialog child is part of the tree for repeat expansion and limits`() {
    val root =
      OverlayColumnNode(
        repeat = OverlayRepeat(listOf(mapOf("n" to OverlayScalar.Text("one"))), "item"),
        children = listOf(dialog(OverlayTextNode(text = "{item.n}"))),
      )
    val mapped = mapOverlaySpec(spec(root, mapOf("open" to OverlayScalar.BooleanValue(true)))).root
    assertEquals("one", mapped.children.single().children.single().text)
    assertEquals(mapOf<String, Int>(), pagerCounts(root))
  }

  @Test
  fun `a snackbar closes after its duration through the injected pause`() = runTest {
    val pauses = mutableListOf<Long>()
    var closed = 0
    awaitSnackbarTimeout(2500, { pauses += it }) { closed++ }
    assertEquals(listOf(2500L), pauses)
    assertEquals(1, closed)
  }

  @Test
  fun `a snackbar without a duration stays and never pauses`() = runTest {
    var paused = false
    var closed = false
    awaitSnackbarTimeout(null, { paused = true }) { closed = true }
    assertFalse(paused)
    assertFalse(closed)
  }

  @Test
  fun `a snackbar closed early never fires its timeout`() = runTest {
    var closed = false
    val job = launch { awaitSnackbarTimeout(1000, { delay(it) }) { closed = true } }
    advanceTimeBy(999)
    job.cancel()
    advanceUntilIdle()
    assertFalse(closed)
  }

  @Test
  fun `the timeout close writes the opposite boolean without running any action`() = runTest {
    val snackbar = OverlaySnackbarNode(openWhen = open, text = "Saved", durationMs = 1000)
    val runtime = runtime(spec(snackbar, mapOf("open" to OverlayScalar.BooleanValue(true))))
    runtime.handle(OverlayInteraction.CloseModal(snackbar.openWhen))
    assertEquals(OverlayScalar.BooleanValue(false), runtime.current.state["open"])
    assertEquals(listOf("change"), events.map { it.name })
  }
}
