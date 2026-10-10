package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.jasonpearson.automobile.ctrlproxy.prototypeResultFrame
import dev.jasonpearson.automobile.ctrlproxy.prototypeStatusFrame
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Live appearance (#11221): the show-level override, re-theming on a device or palette change, the
 * `appearance_changed` event and the resolved mode in the show result, inspect and window metadata.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PrototypeAppearanceTest {
  private val host = FakePrototypeHost()
  private val device = FakePrototypeDeviceAppearance()
  private val events = mutableListOf<PrototypeEvent>()
  private val results = mutableListOf<PrototypeResult>()
  private val json = Json { ignoreUnknownKeys = true }
  private val sink =
    object : PrototypeResultSink {
      private fun record(frame: String) {
        results += json.decodeFromString<WebSocketResponse>(frame) as PrototypeResult
      }

      override suspend fun send(requestId: String?, success: Boolean, error: String?) =
        record(prototypeResultFrame(requestId, success, error))

      override suspend fun sendShown(
        requestId: String?,
        missingAssets: List<String>,
        appearance: PrototypeAppearance,
      ) = record(prototypeResultFrame(requestId, true, null, missingAssets, appearance))

      override suspend fun sendPrototypeStatus(
        requestId: String?,
        prototypes: List<PrototypeStatusEntry>,
        droppedEvents: Long,
      ) = record(prototypeStatusFrame(requestId, prototypes, droppedEvents))
    }
  private val controller =
    PrototypeController(
      host,
      sink,
      eventSink = PrototypeEventSink { events += it },
      clock = { 42L },
      lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
      deviceAppearance = device,
    )

  private val light = PrototypeAppearanceMode.LIGHT
  private val dark = PrototypeAppearanceMode.DARK

  private fun appearance(
    mode: PrototypeAppearanceMode,
    source: PrototypeAppearanceSource,
    deviceDark: Boolean = device.dark,
  ) = PrototypeAppearance(mode, source, deviceDark)

  private fun filled(background: String?) =
    PrototypeStyle(
      width = PrototypeDimension.Fill,
      height = PrototypeDimension.Fill,
      background = background?.let(PrototypeModeValue::Single),
    )

  private fun spec(
    root: PrototypeNode = PrototypeTextNode(text = "{name}"),
    theme: PrototypeSpecTheme? = null,
    state: Map<String, PrototypeScalar>? = null,
  ) =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = root,
      theme = theme,
      state = state,
    )

  /** What the host chrome and the content are drawn from right now. */
  private fun shown(): PrototypeShownTheme = checkNotNull(host.requests.last().theme).value

  private suspend fun inspected(): PrototypeAppearance? {
    controller.inspect("inspect")
    return results.last().prototypes?.single()?.appearance
  }

  private fun model(root: PrototypeNode, theme: PrototypeSpecTheme? = null) =
    mapPrototypeSpec(spec(root, theme))

  private fun resolve(
    root: PrototypeNode = PrototypeSpacerNode(),
    theme: PrototypeSpecTheme? = null,
    deviceDark: Boolean = false,
    override: PrototypeAppearanceOverride? = null,
  ): PrototypeAppearance {
    val model = model(root, theme)
    return prototypeResolveAppearance(model.root, model.theme, deviceDark, override)
  }

  @Test
  fun `the override stands in for the system setting and for nothing above it`() {
    val overrideDark = PrototypeAppearanceOverride.DARK
    val system = PrototypeAppearanceSource.SYSTEM
    val overridden = PrototypeAppearanceSource.OVERRIDE
    assertEquals(PrototypeAppearance(light, system, false), resolve())
    assertEquals(PrototypeAppearance(dark, system, true), resolve(deviceDark = true))
    assertEquals(
      PrototypeAppearance(light, system, false),
      resolve(override = PrototypeAppearanceOverride.DEVICE),
    )
    assertEquals(PrototypeAppearance(dark, overridden, false), resolve(override = overrideDark))
    assertEquals(
      PrototypeAppearance(light, overridden, true),
      resolve(deviceDark = true, override = PrototypeAppearanceOverride.LIGHT),
    )
    assertEquals(
      PrototypeAppearance(dark, overridden, false),
      resolve(theme = PrototypeSpecTheme(mode = "system"), override = overrideDark),
    )
    // An explicit mode is the author's intent: the override does not beat it.
    assertEquals(
      PrototypeAppearance(light, PrototypeAppearanceSource.EXPLICIT, false),
      resolve(theme = PrototypeSpecTheme(mode = "light"), override = overrideDark),
    )
    // Nor a screen colour the author painted: a dark scheme over it would be unreadable.
    assertEquals(
      PrototypeAppearance(light, PrototypeAppearanceSource.ROLE_LUMINANCE, false),
      resolve(
        theme = PrototypeSpecTheme(colors = PrototypeSpecThemeColors(background = "#FFFFFF")),
        override = overrideDark,
      ),
    )
    assertEquals(
      PrototypeAppearance(light, PrototypeAppearanceSource.AUTHORED_BACKGROUND, false),
      resolve(
        PrototypeBoxNode(style = filled("#FFFFFF"), children = emptyList()),
        override = overrideDark,
      ),
    )
  }

  @Test
  fun `a dark override does not beat an authored light background`() = runTest {
    // Owner decision 2026-10-10: the override replaces the system setting only.
    val root = PrototypeBoxNode(style = filled("#FFFFFF"), children = emptyList())
    controller.show("show", spec(root), appearance = PrototypeAppearanceOverride.DARK)
    val expected = appearance(light, PrototypeAppearanceSource.AUTHORED_BACKGROUND)
    assertEquals(expected, results.last().appearance)
    assertEquals(expected, shown().appearance)
    assertEquals(expected, inspected())
  }

  @Test
  fun `a device flip re-themes the same show and sends one appearance_changed event`() = runTest {
    val pager = PrototypePagerNode("pager", children = List(3) { PrototypeTextNode(text = "p") })
    controller.show("show", spec(pager, state = mapOf("name" to PrototypeScalar.Text("Jason"))))
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 2))
    val theme = host.requests.last().theme
    assertEquals(appearance(light, PrototypeAppearanceSource.SYSTEM), results.last().appearance)
    events.clear()

    device.dark = true
    controller.onConfigurationChanged()

    // Chrome darkness is recomputed in the flow the window already collects: no new window.
    assertEquals(appearance(dark, PrototypeAppearanceSource.SYSTEM, true), shown().appearance)
    assertSame(theme, host.requests.last().theme)
    assertEquals(listOf("show", "relayout"), host.calls)
    // Authored state, the pager page and the runtime (so text fields) survive the re-theme.
    assertSame(runtime, controller.activeRuntime)
    assertEquals(mapOf("pager" to 2), runtime.current.pages)
    assertEquals(PrototypeScalar.Text("Jason"), runtime.current.state["name"])
    val event = events.single()
    assertEquals(PrototypeEventKind.APPEARANCE_CHANGED, event.kind)
    assertNull(event.name)
    assertEquals("""{"mode":"dark","source":"system"}""", event.payload.toString())
    assertEquals(2L, event.sequence)
    assertEquals(mapOf("pager" to 2), event.pages)

    // The same setting again, and an unrelated configuration change, send nothing.
    controller.onConfigurationChanged()
    controller.onConfigurationChanged()
    assertEquals(1, events.size)

    device.dark = false
    controller.onConfigurationChanged()
    assertEquals("""{"mode":"light","source":"system"}""", events.last().payload.toString())
    assertEquals(listOf(2L, 3L), events.map { it.sequence })
  }

  @Test
  fun `an explicit mode sends no event on a device flip and still reports the device`() = runTest {
    controller.show("show", spec(theme = PrototypeSpecTheme(mode = "light")))
    device.dark = true
    controller.onConfigurationChanged()
    assertTrue(events.isEmpty())
    assertEquals(appearance(light, PrototypeAppearanceSource.EXPLICIT, true), shown().appearance)
    assertEquals(shown().appearance, inspected())
  }

  @Test
  fun `the override pins the mode for one show and the next show states it afresh`() = runTest {
    controller.show("show", spec(), appearance = PrototypeAppearanceOverride.DARK)
    assertEquals(appearance(dark, PrototypeAppearanceSource.OVERRIDE), results.last().appearance)
    assertEquals(results.last().appearance, shown().appearance)

    // The device flips underneath: the mode is pinned, so nothing is sent, only deviceDark moves.
    device.dark = true
    controller.onConfigurationChanged()
    device.dark = false
    controller.onConfigurationChanged()
    assertTrue(events.isEmpty())
    assertEquals(appearance(dark, PrototypeAppearanceSource.OVERRIDE), inspected())

    // A same-id show without the field follows the device again; the result says so, no event.
    controller.show("again", spec())
    assertEquals(appearance(light, PrototypeAppearanceSource.SYSTEM), results.last().appearance)
    controller.show("device", spec(), appearance = PrototypeAppearanceOverride.DEVICE)
    assertEquals(appearance(light, PrototypeAppearanceSource.SYSTEM), results.last().appearance)
    assertTrue(events.isEmpty())
  }

  @Test
  fun `the show result inspect and window metadata report one resolved appearance`() = runTest {
    device.dark = true
    val pair = PrototypeModeValue.Modes("#FF0000", "#80000000")
    val root =
      PrototypeBoxNode(
        style = filled(null).copy(background = pair),
        children = emptyList(),
      )
    controller.show("show", spec(root))
    val expected = appearance(dark, PrototypeAppearanceSource.SYSTEM)
    assertEquals(expected, results.last().appearance)
    assertEquals(expected, shown().appearance)
    assertEquals(expected, inspected())
    assertEquals(expected, controller.windowMetadata()?.appearance)

    // A failed show reports no appearance, and neither does a dismiss.
    controller.show(
      "bad",
      spec(PrototypeTextNode(text = "t", style = PrototypeStyle(alpha = 2.0))),
    )
    assertFalse(results.last().success)
    assertNull(results.last().appearance)
    controller.dismiss("dismiss", "panel", null)
    assertNull(results.last().appearance)
    assertNull(controller.windowMetadata())
  }

  @Test
  fun `a pager page that flips the inferred mode re-themes host chrome with the content`() =
    runTest {
      val pages =
        listOf("#101010", "#FFFFFF").map {
          PrototypeBoxNode(style = filled(it), children = emptyList())
        }
      controller.show("show", spec(PrototypePagerNode("pager", children = pages)))
      val authored = PrototypeAppearanceSource.AUTHORED_BACKGROUND
      assertEquals(appearance(dark, authored), results.last().appearance)
      val runtime = checkNotNull(controller.activeRuntime)

      controller.interact(runtime, PrototypeInteraction.SettledPage("pager", 1))

      // The theme the host chrome and scrim draw from now names the live page and its mode; it
      // used to stay the tree first shown, so chrome stayed dark around light content.
      assertEquals(appearance(light, authored), shown().appearance)
      assertEquals(1, shown().root.page)
      assertEquals(
        listOf(PrototypeEventKind.PAGE_CHANGED, PrototypeEventKind.APPEARANCE_CHANGED),
        events.map { it.kind },
      )
      assertEquals(
        """{"mode":"light","source":"authoredBackground"}""",
        events.last().payload.toString(),
      )
      assertEquals(listOf(1L, 2L), events.map { it.sequence })
      assertEquals(appearance(light, authored), inspected())
      assertEquals(appearance(light, authored), controller.windowMetadata()?.appearance)
    }

  @Test
  fun `a styleWhen state that flips the inferred mode re-themes and sends one event`() = runTest {
    val root =
      PrototypeBoxNode(
        style = filled("#FFFFFF"),
        styleWhen =
          listOf(
            PrototypeStyleWhen(
              PrototypeCondition("night", PrototypeScalar.BooleanValue(true)),
              filled("#101010"),
            ),
          ),
        children = emptyList(),
      )
    controller.show(
      "show",
      spec(root, state = mapOf("night" to PrototypeScalar.BooleanValue(false))),
    )
    val runtime = checkNotNull(controller.activeRuntime)
    controller.interact(
      runtime,
      PrototypeInteraction.Tap(listOf(PrototypeToggleAction("night"))),
    )
    assertEquals(dark, shown().appearance.mode)
    assertEquals(
      listOf("change" to PrototypeEventKind.EMIT, null to PrototypeEventKind.APPEARANCE_CHANGED),
      events.map { it.name to it.kind },
    )
  }

  @Test
  fun `window opacity follows the mode the window is drawn in`() = runTest {
    // Opaque in light, translucent in dark: every reachable mode says no, the drawn one says yes.
    val root =
      PrototypeBoxNode(
        style = filled(null).copy(background = PrototypeModeValue.Modes("#FF0000", "#80000000")),
        children = emptyList(),
      )
    val window =
      PrototypeWindow(
        PrototypeFullscreenPlacement(scrim = PrototypeModeValue.Modes("#FF000000", "#80000000")),
      )
    assertFalse(
      prototypeWindowMetadata(mapPrototypeSpec(spec(root).copy(window = window)), true).opaque,
    )
    val model = mapPrototypeSpec(spec(root).copy(window = window))
    fun drawn(deviceDark: Boolean): PrototypeWindowMetadata {
      val theme =
        PrototypeShownTheme(
          model.root,
          model.theme,
          prototypeResolveAppearance(model.root, model.theme, deviceDark),
        )
      return prototypeWindowMetadata(model, true, listOf(prototypeShownPalette(theme)))
    }
    assertTrue(drawn(deviceDark = false).opaque)
    assertFalse(drawn(deviceDark = true).opaque)
  }

  @Test
  fun `a palette change refreshes the shown theme without an event`() = runTest {
    val theme = PrototypeSpecTheme(colors = PrototypeSpecThemeColors(source = "device"))
    controller.show("show", spec(theme = theme))
    val before = shown()
    device.paletteKey = 7
    controller.onConfigurationChanged()
    assertEquals(before.copy(paletteKey = 7), shown())
    assertTrue(events.isEmpty())
  }

  @Test
  fun `a hidden prototype still resolves and reports a device flip`() = runTest {
    var blocked = false
    val locked =
      PrototypeController(
        host,
        sink,
        eventSink = PrototypeEventSink { events += it },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer(), isBlocked = { blocked }),
        deviceAppearance = device,
      )
    locked.show("show", spec())
    blocked = true
    locked.onConfigurationChanged()
    assertFalse(host.isShowing)
    device.dark = true
    locked.onConfigurationChanged()
    assertEquals(PrototypeEventKind.APPEARANCE_CHANGED, events.single().kind)
    // The window comes back from the same request, so in the mode resolved while it was hidden.
    blocked = false
    locked.onConfigurationChanged()
    assertTrue(host.isShowing)
    assertEquals(dark, shown().appearance.mode)
  }

  @Test
  @Config(qualifiers = "notnight")
  fun `the device appearance reads the service configuration as it changes`() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val appearance = AndroidPrototypeDeviceAppearance(context)
    assertFalse(appearance.dark)
    RuntimeEnvironment.setQualifiers("+night")
    assertTrue(appearance.dark)
    // No dynamic colour below API 31: the key never moves there.
    assertEquals(0, AndroidPrototypeDeviceAppearance(context, sdkInt = 30).paletteKey)
    assertEquals(appearance.paletteKey, AndroidPrototypeDeviceAppearance(context).paletteKey)
  }
}
