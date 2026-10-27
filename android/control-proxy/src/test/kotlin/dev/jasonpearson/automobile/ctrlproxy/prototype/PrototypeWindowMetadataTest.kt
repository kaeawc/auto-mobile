package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.ctrlproxy.models.PrototypeWindowMotion
import dev.jasonpearson.automobile.ctrlproxy.models.WindowInfo
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeWindowMetadataTest {
  private fun spec(
    placement: dev.jasonpearson.automobile.protocol.PrototypePlacement,
    background: String? = "#FF101010",
    opacity: Int = 100,
    alpha: Double? = null,
    fill: Boolean = true,
  ) =
    PrototypeSpec(
      "panel",
      PrototypeWindow(placement, opacity),
      root =
        PrototypeBoxNode(
          style =
            PrototypeStyle(
              width = if (fill) PrototypeDimension.Fill else null,
              height = if (fill) PrototypeDimension.Fill else null,
              background = background?.let(PrototypeModeValue::Single),
              alpha = alpha,
            ),
          children = emptyList(),
        ),
    )

  // The bar remains translucent when requested; the cases below that
  // exercise the surface rules assume an opaque bar so they isolate the root/scrim logic.
  private fun metadata(spec: PrototypeSpec, dismissBarOpaque: Boolean = true) =
    prototypeWindowMetadata(mapPrototypeSpec(spec), dismissBarOpaque)

  @Test
  fun `prototype titles carry only nonempty ids and still require the window type and owner`() {
    val type = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
    assertEquals(PROTOTYPE_WINDOW_TITLE, prototypeWindowTitle(null))
    assertEquals("AutoMobile Prototype:a", prototypeWindowTitle("a"))
    for ((title, id) in
      listOf(
        PROTOTYPE_WINDOW_TITLE to null,
        "AutoMobile Prototype:a" to "a",
        "AutoMobile Prototype:a:b" to "a:b",
      )) {
      assertEquals(id, prototypeIdOfTitle(title))
      assertTrue(hasPrototypeTitle(type, title))
      assertTrue(isPrototypeWindow(type, title, "own", "own"))
      assertTrue(hasPrototypeTitle(AccessibilityWindowInfo.TYPE_SYSTEM, title))
      assertFalse(hasPrototypeTitle(AccessibilityWindowInfo.TYPE_APPLICATION, title))
      assertFalse(isPrototypeWindow(type, title, "other", "own"))
    }
    for (title in
      listOf(null, "AutoMobile Prototype:", "AutoMobile Prototype Foo", "AutoMobile Highlight")) {
      assertNull(prototypeIdOfTitle(title))
      assertFalse(hasPrototypeTitle(type, title))
      assertFalse(isPrototypeWindow(type, title, "own", "own"))
    }
  }

  @Test
  fun `the translucent fullscreen dismiss bar keeps a fullscreen window from reporting opaque`() {
    assertEquals(
      PrototypeWindowMetadata("fullscreen", false),
      prototypeWindowMetadata(mapPrototypeSpec(spec(PrototypeFullscreenPlacement()))),
    )
    assertEquals(
      PrototypeWindowMetadata("fullscreen", false),
      prototypeWindowMetadata(
        mapPrototypeSpec(
          spec(
            PrototypeFullscreenPlacement(scrim = PrototypeModeValue.Single("#FF000000")),
            background = null,
          ),
        ),
      ),
    )
  }

  @Test
  fun `opaque fullscreen without the bar reports opaque while the bar keeps it translucent`() {
    val model = mapPrototypeSpec(spec(PrototypeFullscreenPlacement()))
    assertTrue(prototypeWindowMetadata(model, dismissBarDrawn = false).opaque)
    assertFalse(prototypeWindowMetadata(model, dismissBarDrawn = true).opaque)
  }

  @Test
  fun `a wrap-content root is not opaque even with a solid background`() {
    assertEquals(
      PrototypeWindowMetadata("fullscreen", false),
      metadata(spec(PrototypeFullscreenPlacement(), fill = false)),
    )
  }

  @Test
  fun `fullscreen with an opaque root at full window opacity is opaque`() {
    assertEquals(
      PrototypeWindowMetadata("fullscreen", true),
      metadata(spec(PrototypeFullscreenPlacement())),
    )
  }

  private fun styled(change: (PrototypeStyle) -> PrototypeStyle): PrototypeWindowMetadata {
    val base = spec(PrototypeFullscreenPlacement())
    val root = base.root as PrototypeBoxNode
    return metadata(base.copy(root = root.copy(style = change(checkNotNull(root.style)))))
  }

  @Test
  fun `a filling root that the renderer draws short of the window is not opaque`() {
    val shortOfTheWindow =
      mapOf<String, (PrototypeStyle) -> PrototypeStyle>(
        "rounded corners" to { it.copy(cornerRadius = PrototypeCornerRadius.Dp(48.0)) },
        "one rounded corner" to
          {
            it.copy(cornerRadius = PrototypeCornerRadius.Corners(topStart = 16.0))
          },
        "a shape token" to { it.copy(cornerRadius = PrototypeCornerRadius.Token("large")) },
        "an offset" to { it.copy(offset = PrototypeOffset(120.0, 0.0)) },
        "a width cap" to { it.copy(maxWidth = 200.0) },
        "a height cap" to { it.copy(maxHeight = 200.0) },
        "an aspect ratio" to { it.copy(aspectRatio = 1.0) },
        "a press scale" to { it.copy(pressScale = 0.9) },
      )
    shortOfTheWindow.forEach { (name, change) ->
      assertEquals(name, PrototypeWindowMetadata("fullscreen", false), styled(change))
    }
  }

  @Test
  fun `an anchored root is laid out at its anchor so it never counts as covering`() {
    val placements =
      listOf(
        PrototypeFullscreenPlacement(),
        PrototypeSheetPlacement(edge = "bottom", height = 200.0),
        PrototypeFloatingPlacement(gravity = "topStart", offset = PrototypeOffset(0.0, 0.0)),
      )
    val anchors =
      listOf(
        PrototypeBoundsAnchor(PrototypeBounds(40.0, 40.0, 80.0, 80.0)),
        PrototypeBoundsAnchor(PrototypeBounds(40.0, 40.0, 80.0, 80.0), "cover"),
        PrototypeBoundsAnchor(PrototypeBounds(40.0, 40.0, 80.0, 80.0), "below"),
      )
    for (placement in placements) {
      val base = spec(placement)
      val root = base.root as PrototypeBoxNode
      // Control: the same root without an anchor covers its window.
      assertTrue(placement.toString(), metadata(base).opaque)
      for (anchor in anchors) {
        val anchored = metadata(base.copy(root = root.copy(anchor = anchor)))
        assertFalse("$placement $anchor", anchored.opaque)
      }
    }
  }

  @Test
  fun `square corners and a zero offset still cover the window`() {
    val covering =
      listOf<(PrototypeStyle) -> PrototypeStyle>(
        { it.copy(cornerRadius = PrototypeCornerRadius.Dp(0.0)) },
        { it.copy(cornerRadius = PrototypeCornerRadius.Token("none")) },
        { it.copy(cornerRadius = PrototypeCornerRadius.Corners(topStart = 0.0)) },
        { it.copy(offset = PrototypeOffset(0.0, 0.0)) },
        { it.copy(minWidth = 10.0, minHeight = 10.0) },
      )
    covering.forEach {
      assertEquals(PrototypeWindowMetadata("fullscreen", true), styled(it))
    }
  }

  @Test
  fun `an opaque fullscreen scrim still covers what a rounded root leaves open`() {
    val base = spec(PrototypeFullscreenPlacement(scrim = PrototypeModeValue.Single("#FF000000")))
    val root = base.root as PrototypeBoxNode
    val rounded = checkNotNull(root.style).copy(cornerRadius = PrototypeCornerRadius.Dp(48.0))
    assertEquals(
      PrototypeWindowMetadata("fullscreen", true),
      metadata(base.copy(root = root.copy(style = rounded))),
    )
  }

  @Test
  fun `a translucent root background is not opaque`() {
    assertEquals(
      PrototypeWindowMetadata("fullscreen", false),
      metadata(spec(PrototypeFullscreenPlacement(), background = "#80101010")),
    )
  }

  @Test
  fun `a missing root background is not opaque`() {
    assertEquals(
      PrototypeWindowMetadata("fullscreen", false),
      metadata(spec(PrototypeFullscreenPlacement(), background = null)),
    )
  }

  @Test
  fun `window opacity below 100 is not opaque even with an opaque root`() {
    assertEquals(
      PrototypeWindowMetadata("fullscreen", false),
      metadata(spec(PrototypeFullscreenPlacement(), opacity = 60)),
    )
  }

  @Test
  fun `node alpha below one is not opaque`() {
    assertEquals(
      PrototypeWindowMetadata("fullscreen", false),
      metadata(spec(PrototypeFullscreenPlacement(), alpha = 0.5)),
    )
  }

  @Test
  fun `a fully opaque fullscreen scrim makes a transparent root opaque, a dimming one does not`() {
    assertEquals(
      PrototypeWindowMetadata("fullscreen", true),
      metadata(
        spec(
          PrototypeFullscreenPlacement(scrim = PrototypeModeValue.Single("#FF000000")),
          background = null,
        ),
      ),
    )
    assertEquals(
      PrototypeWindowMetadata("fullscreen", false),
      metadata(
        spec(
          PrototypeFullscreenPlacement(scrim = PrototypeModeValue.Single("#66000000")),
          background = null,
        ),
      ),
    )
  }

  @Test
  fun `sheet and floating placements are named`() {
    assertEquals(
      "sheet",
      metadata(spec(PrototypeSheetPlacement(edge = "bottom", height = 200.0))).placement,
    )
    assertEquals(
      "floating",
      metadata(
          spec(
            PrototypeFloatingPlacement(gravity = "topStart", offset = PrototypeOffset(0.0, 0.0)),
          ),
        )
        .placement,
    )
  }

  @Test
  fun `only the prototype window of our own package matches`() {
    val accessibilityOverlay = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
    val title = PROTOTYPE_WINDOW_TITLE
    assertTrue(isPrototypeWindow(accessibilityOverlay, title, "own.pkg", "own.pkg"))
    // The highlight overlay shares the type and package but not the title.
    assertFalse(
      isPrototypeWindow(accessibilityOverlay, "AutoMobile Highlight", "own.pkg", "own.pkg"),
    )
    assertFalse(isPrototypeWindow(accessibilityOverlay, null, "own.pkg", "own.pkg"))
    assertFalse(isPrototypeWindow(accessibilityOverlay, title, "other.pkg", "own.pkg"))
    assertFalse(isPrototypeWindow(accessibilityOverlay, title, null, "own.pkg"))
    // The app layer's TYPE_APPLICATION_OVERLAY window reports as TYPE_SYSTEM (#10544).
    val appLayer = AccessibilityWindowInfo.TYPE_SYSTEM
    assertTrue(isPrototypeWindow(appLayer, title, "own.pkg", "own.pkg"))
    // SystemUI's type-3 windows share the type but never the title or package.
    assertFalse(
      isPrototypeWindow(appLayer, "NotificationShade", "com.android.systemui", "own.pkg"),
    )
    assertFalse(isPrototypeWindow(appLayer, title, "com.android.systemui", "own.pkg"))
    assertFalse(isPrototypeWindow(appLayer, null, "own.pkg", "own.pkg"))
    assertFalse(
      isPrototypeWindow(
        AccessibilityWindowInfo.TYPE_APPLICATION,
        title,
        "own.pkg",
        "own.pkg",
      ),
    )
  }

  @Test
  fun `window entries omit the prototype fields unless set and still decode from older APKs`() {
    val wire = Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
    val plain = wire.encodeToString(WindowInfo.serializer(), WindowInfo(id = 3, type = 1))
    assertFalse(plain.contains("prototypePlacement"))
    assertFalse(plain.contains("prototypeOpaque"))

    val prototype =
      WindowInfo(id = 4, type = 4, prototypePlacement = "fullscreen", prototypeOpaque = true)
    val encoded = wire.encodeToString(WindowInfo.serializer(), prototype)
    assertTrue(encoded.contains("\"prototypePlacement\":\"fullscreen\""))
    assertTrue(encoded.contains("\"prototypeOpaque\":true"))
    assertEquals(prototype, wire.decodeFromString(WindowInfo.serializer(), encoded))
    assertNull(
      wire.decodeFromString(WindowInfo.serializer(), """{"id":3,"type":4}""").prototypePlacement,
    )
  }

  @Test
  fun `window entries carry the prototype appearance only when set and round trip it`() {
    val wire = Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
    assertFalse(
      wire
        .encodeToString(WindowInfo.serializer(), WindowInfo(id = 3, type = 1))
        .contains("prototypeAppearance"),
    )
    val prototype =
      WindowInfo(
        id = 4,
        type = 4,
        prototypePlacement = "fullscreen",
        prototypeOpaque = false,
        prototypeAppearance =
          PrototypeAppearance(
            PrototypeAppearanceMode.DARK,
            PrototypeAppearanceSource.AUTHORED_BACKGROUND,
            deviceDark = false,
          ),
      )
    val encoded = wire.encodeToString(WindowInfo.serializer(), prototype)
    assertTrue(
      encoded,
      encoded.contains(
        """"prototypeAppearance":{"mode":"dark","source":"authoredBackground","deviceDark":false}""",
      ),
    )
    assertEquals(prototype, wire.decodeFromString(WindowInfo.serializer(), encoded))
    // An APK that predates prototype_appearance_v1 sends placement and opacity alone.
    val older = """{"id":4,"type":4,"prototypePlacement":"fullscreen","prototypeOpaque":false}"""
    assertNull(wire.decodeFromString(WindowInfo.serializer(), older).prototypeAppearance)
  }

  @Test
  fun `window entries carry the prototype motion only when set and round trip it`() {
    val wire = Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
    assertFalse(
      wire
        .encodeToString(WindowInfo.serializer(), WindowInfo(id = 3, type = 1))
        .contains("prototypeMotion"),
    )
    val prototype =
      WindowInfo(
        id = 4,
        type = 4,
        prototypePlacement = "floating",
        prototypeMotion = PrototypeWindowMotion(active = 2, loops = 1),
      )
    val encoded = wire.encodeToString(WindowInfo.serializer(), prototype)
    assertTrue(encoded, encoded.contains(""""prototypeMotion":{"active":2,"loops":1}"""))
    assertEquals(prototype, wire.decodeFromString(WindowInfo.serializer(), encoded))
    // An APK that predates the motion signal sends none, and the host reads that as settled.
    assertNull(
      wire
        .decodeFromString(WindowInfo.serializer(), """{"id":4,"prototypePlacement":"floating"}""")
        .prototypeMotion,
    )
  }

  @Test
  fun `controller reports the active prototype and nothing once it is dismissed`() = runTest {
    val host = FakePrototypeHost()
    val controller =
      PrototypeController(
        host,
        PrototypeResultSink { _, _, _ -> },
        lifecycle = PrototypeLifecycle(FakePrototypeTimer()),
        render = { mapPrototypeSpec(it).request() },
      )
    assertNull(controller.windowMetadata())

    controller.show("r1", spec(PrototypeFullscreenPlacement()))
    val activity = checkNotNull(host.requests.last().motionActivity)
    assertFalse(activity.captureHeld())
    // The appearance the show resolved to rides along; PrototypeAppearanceTest covers it.
    fun placementAndOpacity() = controller.windowMetadata()?.copy(appearance = null, motion = null)
    assertEquals(PrototypeWindowMetadata("fullscreen", true), placementAndOpacity())
    assertTrue(activity.captureHeld())
    // Nothing animates in a freshly shown, static prototype (#15114).
    assertEquals(PrototypeMotionState.Settled, controller.windowMetadata()?.motion)

    controller.show(
      "bar",
      spec(PrototypeFullscreenPlacement()).let { it.copy(window = it.window.copy(chrome = "bar")) },
    )
    assertEquals(PrototypeWindowMetadata("fullscreen", false), placementAndOpacity())

    controller.show("r2", spec(PrototypeSheetPlacement("bottom", 120.0), opacity = 50))
    assertEquals(PrototypeWindowMetadata("sheet", false), placementAndOpacity())

    controller.dismiss("r3", "panel", null)
    assertNull(controller.windowMetadata())
  }
}
