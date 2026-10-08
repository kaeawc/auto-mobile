package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.accessibility.AccessibilityWindowInfo
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
class OverlayWindowMetadataTest {
  private fun spec(
    placement: dev.jasonpearson.automobile.protocol.OverlayPlacement,
    background: String? = "#FF101010",
    opacity: Int = 100,
    alpha: Double? = null,
    fill: Boolean = true,
  ) =
    OverlaySpec(
      "panel",
      OverlayWindow(placement, opacity),
      root =
        OverlayBoxNode(
          style =
            OverlayStyle(
              width = if (fill) OverlayDimension.Fill else null,
              height = if (fill) OverlayDimension.Fill else null,
              background = background,
              alpha = alpha,
            ),
          children = emptyList(),
        ),
    )

  // The shipped host draws a translucent dismiss bar over fullscreen windows; the cases below that
  // exercise the surface rules assume an opaque bar so they isolate the root/scrim logic.
  private fun metadata(spec: OverlaySpec, dismissBarOpaque: Boolean = true) =
    overlayWindowMetadata(mapOverlaySpec(spec), dismissBarOpaque)

  @Test
  fun `the translucent fullscreen dismiss bar keeps a fullscreen window from reporting opaque`() {
    assertEquals(
      OverlayWindowMetadata("fullscreen", false),
      overlayWindowMetadata(mapOverlaySpec(spec(OverlayFullscreenPlacement()))),
    )
    assertEquals(
      OverlayWindowMetadata("fullscreen", false),
      overlayWindowMetadata(
        mapOverlaySpec(spec(OverlayFullscreenPlacement(scrim = "#FF000000"), background = null))
      ),
    )
  }

  @Test
  fun `a wrap-content root is not opaque even with a solid background`() {
    assertEquals(
      OverlayWindowMetadata("fullscreen", false),
      metadata(spec(OverlayFullscreenPlacement(), fill = false)),
    )
  }

  @Test
  fun `fullscreen with an opaque root at full window opacity is opaque`() {
    assertEquals(
      OverlayWindowMetadata("fullscreen", true),
      metadata(spec(OverlayFullscreenPlacement())),
    )
  }

  @Test
  fun `a translucent root background is not opaque`() {
    assertEquals(
      OverlayWindowMetadata("fullscreen", false),
      metadata(spec(OverlayFullscreenPlacement(), background = "#80101010")),
    )
  }

  @Test
  fun `a missing root background is not opaque`() {
    assertEquals(
      OverlayWindowMetadata("fullscreen", false),
      metadata(spec(OverlayFullscreenPlacement(), background = null)),
    )
  }

  @Test
  fun `window opacity below 100 is not opaque even with an opaque root`() {
    assertEquals(
      OverlayWindowMetadata("fullscreen", false),
      metadata(spec(OverlayFullscreenPlacement(), opacity = 60)),
    )
  }

  @Test
  fun `node alpha below one is not opaque`() {
    assertEquals(
      OverlayWindowMetadata("fullscreen", false),
      metadata(spec(OverlayFullscreenPlacement(), alpha = 0.5)),
    )
  }

  @Test
  fun `a fully opaque fullscreen scrim makes a transparent root opaque, a dimming one does not`() {
    assertEquals(
      OverlayWindowMetadata("fullscreen", true),
      metadata(spec(OverlayFullscreenPlacement(scrim = "#FF000000"), background = null)),
    )
    assertEquals(
      OverlayWindowMetadata("fullscreen", false),
      metadata(spec(OverlayFullscreenPlacement(scrim = "#66000000"), background = null)),
    )
  }

  @Test
  fun `sheet and floating placements are named`() {
    assertEquals(
      "sheet",
      metadata(spec(OverlaySheetPlacement(edge = "bottom", height = 200.0))).placement,
    )
    assertEquals(
      "floating",
      metadata(
          spec(OverlayFloatingPlacement(gravity = "topStart", offset = OverlayOffset(0.0, 0.0)))
        )
        .placement,
    )
  }

  @Test
  fun `only the interactive overlay window of our own package matches`() {
    val overlay = AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY
    val title = INTERACTIVE_OVERLAY_WINDOW_TITLE
    assertTrue(isInteractiveOverlayWindow(overlay, title, "own.pkg", "own.pkg"))
    // The highlight overlay shares the type and package but not the title.
    assertFalse(isInteractiveOverlayWindow(overlay, "AutoMobile Highlight", "own.pkg", "own.pkg"))
    assertFalse(isInteractiveOverlayWindow(overlay, null, "own.pkg", "own.pkg"))
    assertFalse(isInteractiveOverlayWindow(overlay, title, "other.pkg", "own.pkg"))
    assertFalse(isInteractiveOverlayWindow(overlay, title, null, "own.pkg"))
    // The app layer's TYPE_APPLICATION_OVERLAY window reports as TYPE_SYSTEM (#10544).
    val appLayer = AccessibilityWindowInfo.TYPE_SYSTEM
    assertTrue(isInteractiveOverlayWindow(appLayer, title, "own.pkg", "own.pkg"))
    // SystemUI's type-3 windows share the type but never the title or package.
    assertFalse(
      isInteractiveOverlayWindow(appLayer, "NotificationShade", "com.android.systemui", "own.pkg")
    )
    assertFalse(isInteractiveOverlayWindow(appLayer, title, "com.android.systemui", "own.pkg"))
    assertFalse(isInteractiveOverlayWindow(appLayer, null, "own.pkg", "own.pkg"))
    assertFalse(
      isInteractiveOverlayWindow(
        AccessibilityWindowInfo.TYPE_APPLICATION,
        title,
        "own.pkg",
        "own.pkg",
      )
    )
  }

  @Test
  fun `window entries omit the overlay fields unless set and still decode from older APKs`() {
    val wire = Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
    val plain = wire.encodeToString(WindowInfo.serializer(), WindowInfo(id = 3, type = 1))
    assertFalse(plain.contains("overlayPlacement"))
    assertFalse(plain.contains("overlayOpaque"))

    val overlay =
      WindowInfo(id = 4, type = 4, overlayPlacement = "fullscreen", overlayOpaque = true)
    val encoded = wire.encodeToString(WindowInfo.serializer(), overlay)
    assertTrue(encoded.contains("\"overlayPlacement\":\"fullscreen\""))
    assertTrue(encoded.contains("\"overlayOpaque\":true"))
    assertEquals(overlay, wire.decodeFromString(WindowInfo.serializer(), encoded))
    assertNull(
      wire.decodeFromString(WindowInfo.serializer(), """{"id":3,"type":4}""").overlayPlacement
    )
  }

  @Test
  fun `controller reports the active overlay and nothing once it is dismissed`() = runTest {
    val host = FakeInteractiveOverlayHost()
    val controller =
      OverlayController(
        host,
        OverlayResultSink { _, _, _ -> },
        lifecycle = OverlayLifecycle(FakeOverlayTimer()),
        render = { mapOverlaySpec(it).request() },
      )
    assertNull(controller.windowMetadata())

    controller.show("r1", spec(OverlayFullscreenPlacement()))
    assertEquals(OverlayWindowMetadata("fullscreen", false), controller.windowMetadata())

    controller.show("r2", spec(OverlaySheetPlacement("bottom", 120.0), opacity = 50))
    assertEquals(OverlayWindowMetadata("sheet", false), controller.windowMetadata())

    controller.dismiss("r3", "panel", null)
    assertNull(controller.windowMetadata())
  }
}
