package dev.jasonpearson.automobile.ctrlproxy.prototype

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
class PrototypeMaterialComponentsTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private var sequence = 0L
  private val open = PrototypeSheetCondition("open", true)

  private fun spec(root: PrototypeNode, state: Map<String, PrototypeScalar>) =
    PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), state, root)

  private fun runtime(spec: PrototypeSpec) =
    PrototypeRuntime(spec, { events += it }, { 42L }, { ++sequence })

  private fun dialog(child: PrototypeNode? = null) =
    PrototypeDialogNode(
      openWhen = open,
      title = "Delete {name}?",
      text = "{name} goes away.",
      confirm = PrototypeDialogButton("Delete", listOf(PrototypeEmitAction("delete"))),
      dismiss = PrototypeDialogButton("Cancel"),
      child = child,
    )

  @Test
  fun `each new node maps its role label and bound state`() {
    val state =
      mapOf(
        "open" to PrototypeScalar.BooleanValue(true),
        "name" to PrototypeScalar.Text("Wake"),
        "mode" to PrototypeScalar.Text("b"),
        "upload" to PrototypeScalar.Numeric(30.0),
        "hour" to PrototypeScalar.Numeric(7.0),
        "minute" to PrototypeScalar.Numeric(5.0),
        "date" to PrototypeScalar.Text("2026-10-08"),
      )
    val root =
      mapPrototypeSpec(
          spec(
            PrototypeColumnNode(
              children =
                listOf(
                  PrototypeIconButtonNode(icon = "delete"),
                  PrototypeFabNode(icon = "add", label = "New"),
                  PrototypeSegmentedButtonNode(
                    stateKey = "mode",
                    options =
                      listOf(PrototypeRadioOption("a", "A"), PrototypeRadioOption("b", "B")),
                  ),
                  PrototypeTopAppBarNode(title = "Hi {name}"),
                  PrototypeDividerNode(),
                  PrototypeBadgeNode(text = "3"),
                  PrototypeProgressNode(stateKey = "upload", max = 100.0),
                  dialog(),
                  PrototypeSnackbarNode(openWhen = open, text = "Saved {name}"),
                  PrototypeTimePickerNode(hourKey = "hour", minuteKey = "minute"),
                  PrototypeDatePickerNode(stateKey = "date"),
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
    assertEquals("07:05", prototypePickerValue(nodes[9]))
    assertEquals("2026-10-08", prototypePickerValue(nodes[10]))
    assertEquals("07:05", prototypeStateDescription("timePicker", 0, 0, "07:05"))
    assertNull(prototypeStateDescription("progress", 0, 0, "07:05"))
    assertEquals(listOf("dialog", "snackbar"), modalPrototypeSheets(root).map { it.role })
  }

  @Test
  fun `an icon control is labelled by its icon unless a label or description is authored`() {
    assertEquals(
      "delete",
      prototypeContentDescription("iconButton", "", "delete", tappable = false),
    )
    assertEquals("New", prototypeContentDescription("fab", "New", "add", tappable = false))
    assertEquals(
      "Remove",
      prototypeContentDescription(
        "iconButton",
        "",
        "delete",
        tappable = false,
        authored = "Remove",
      ),
    )
  }

  @Test
  fun `a closed dialog is not hoisted and its text field does not take focus`() {
    val field = PrototypeTextFieldNode(stateKey = "name")
    val closed =
      mapPrototypeSpec(
          spec(
            dialog(field),
            mapOf(
              "open" to PrototypeScalar.BooleanValue(false),
              "name" to PrototypeScalar.Text(""),
            ),
          ),
        )
        .root
    assertTrue(modalPrototypeSheets(closed).isEmpty())
    assertFalse(hasVisibleTextField(closed))
    val shown =
      mapPrototypeSpec(
          spec(
            dialog(field),
            mapOf("open" to PrototypeScalar.BooleanValue(true), "name" to PrototypeScalar.Text("")),
          ),
        )
        .root
    assertTrue(hasVisibleTextField(shown))
    assertEquals("root.child", shown.children.single().identity)
  }

  @Test
  fun `a dialog button closes the dialog emits change then runs its actions`() = runTest {
    val runtime = runtime(spec(dialog(), mapOf("open" to PrototypeScalar.BooleanValue(true))))
    runtime.handle(PrototypeInteraction.CloseModal(open, listOf(PrototypeEmitAction("delete"))))
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["open"])
    assertEquals(listOf("change", "delete"), events.map { it.name })
  }

  @Test
  fun `closing an already closed dialog still runs the button actions but emits no change`() =
    runTest {
      val runtime = runtime(spec(dialog(), mapOf("open" to PrototypeScalar.BooleanValue(false))))
      runtime.handle(PrototypeInteraction.CloseModal(open, listOf(PrototypeEmitAction("delete"))))
      assertEquals(listOf("delete"), events.map { it.name })
    }

  @Test
  fun `a time change stores both keys in one change event then runs actions`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeTimePickerNode(hourKey = "hour", minuteKey = "minute"),
          mapOf("hour" to PrototypeScalar.Numeric(7.0), "minute" to PrototypeScalar.Numeric(30.0)),
        ),
      )
    runtime.handle(
      PrototypeInteraction.SetTime("hour", "minute", 8, 45, listOf(PrototypeEmitAction("time"))),
    )
    assertEquals(PrototypeScalar.Numeric(8.0), runtime.current.state["hour"])
    assertEquals(PrototypeScalar.Numeric(45.0), runtime.current.state["minute"])
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
    runtime.handle(PrototypeInteraction.SetTime("hour", "minute", 8, 50))
    assertEquals(
      buildJsonObject {
        put("key", "minute")
        put("value", 50.0)
      },
      events.last().payload,
    )
    runtime.handle(PrototypeInteraction.SetTime("hour", "minute", 8, 50))
    assertEquals(3, events.size)
  }

  @Test
  fun `a time change outside the picker range is rejected by the validator`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeTimePickerNode(hourKey = "hour", minuteKey = "minute"),
          mapOf("hour" to PrototypeScalar.Numeric(7.0), "minute" to PrototypeScalar.Numeric(30.0)),
        ),
      )
    val error = runCatching {
      runtime.handle(PrototypeInteraction.SetTime("hour", "minute", 24, 0))
    }
    assertTrue("$error", error.exceptionOrNull() is IllegalArgumentException)
    assertEquals(PrototypeScalar.Numeric(7.0), runtime.current.state["hour"])
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a time change on keys that are not numbers is inert`() = runTest {
    val runtime = runtime(spec(PrototypeSpacerNode(), mapOf("hour" to PrototypeScalar.Text("7"))))
    runtime.handle(PrototypeInteraction.SetTime("hour", "minute", 8, 0))
    assertEquals(PrototypeScalar.Text("7"), runtime.current.state["hour"])
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a picked date binds the string key like a radio choice`() = runTest {
    val runtime =
      runtime(
        spec(
          PrototypeDatePickerNode(stateKey = "date"),
          mapOf("date" to PrototypeScalar.Text("2026-10-08")),
        ),
      )
    runtime.handle(PrototypeInteraction.Choose("date", "2026-12-25"))
    assertEquals(PrototypeScalar.Text("2026-12-25"), runtime.current.state["date"])
    val error = runCatching { runtime.handle(PrototypeInteraction.Choose("date", "2026-13-01")) }
    assertTrue("$error", error.exceptionOrNull() is IllegalArgumentException)
  }

  @Test
  fun `dates convert to and from the picker's UTC midnight`() {
    val millis = checkNotNull(prototypeDateMillis("2024-02-29"))
    assertEquals(1709164800000L, millis)
    assertEquals("2024-02-29", prototypeDateString(millis))
    assertEquals("1900-01-01", prototypeDateString(checkNotNull(prototypeDateMillis("1900-01-01"))))
    assertNull(prototypeDateMillis(null))
    assertNull(prototypeDateMillis("2024-02"))
  }

  @Test
  fun `the validator accepts only real dates in the picker year range`() {
    assertTrue(PrototypeSpecValidator.isPrototypeDate("2024-02-29"))
    assertFalse(PrototypeSpecValidator.isPrototypeDate("2023-02-29"))
    assertFalse(PrototypeSpecValidator.isPrototypeDate("2100-02-29"))
    assertTrue(PrototypeSpecValidator.isPrototypeDate("2000-02-29"))
    assertFalse(PrototypeSpecValidator.isPrototypeDate("2101-01-01"))
    assertFalse(PrototypeSpecValidator.isPrototypeDate("2026-1-01"))
  }

  @Test
  fun `a determinate progress draws its value over max`() {
    assertEquals(0.3f, prototypeProgressFraction(30.0, 100.0), 1e-6f)
    assertEquals(0.4f, prototypeProgressFraction(0.4, null), 1e-6f)
    assertEquals(1f, prototypeProgressFraction(2.0, null), 0f)
  }

  @Test
  fun `a dialog child is part of the tree for repeat expansion and limits`() {
    val root =
      PrototypeColumnNode(
        repeat = PrototypeRepeat(listOf(mapOf("n" to PrototypeScalar.Text("one"))), "item"),
        children = listOf(dialog(PrototypeTextNode(text = "{item.n}"))),
      )
    val mapped =
      mapPrototypeSpec(spec(root, mapOf("open" to PrototypeScalar.BooleanValue(true)))).root
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
    val snackbar = PrototypeSnackbarNode(openWhen = open, text = "Saved", durationMs = 1000)
    val runtime = runtime(spec(snackbar, mapOf("open" to PrototypeScalar.BooleanValue(true))))
    runtime.handle(PrototypeInteraction.CloseModal(snackbar.openWhen))
    assertEquals(PrototypeScalar.BooleanValue(false), runtime.current.state["open"])
    assertEquals(listOf("change"), events.map { it.name })
  }
}
