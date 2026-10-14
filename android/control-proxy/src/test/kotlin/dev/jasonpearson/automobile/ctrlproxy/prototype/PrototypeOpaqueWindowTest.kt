package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class PrototypeWindowOpaqueTest {
  private fun opaqueRequest() =
    PrototypeRequest(
      placement = PrototypePlacement.Fullscreen(),
      chrome = PrototypeWindowChrome.NONE,
      opaqueSurface = true,
    )

  @Test
  fun `chromeless fullscreen with an opaque surface at full opacity uses an opaque window`() {
    assertTrue(prototypeWindowOpaque(opaqueRequest()))
  }

  @Test
  fun `dismiss bar and reduced opacity keep opaque surfaces translucent`() {
    val request = opaqueRequest()
    assertFalse(prototypeWindowOpaque(request.copy(chrome = PrototypeWindowChrome.BAR)))
    assertFalse(prototypeWindowOpaque(request.copy(opacityPercent = 90)))
  }

  @Test
  fun `non-fullscreen placements and unproven surfaces keep the window translucent`() {
    val request = opaqueRequest()
    assertFalse(
      prototypeWindowOpaque(
        request.copy(placement = PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 200f)),
      ),
    )
    assertFalse(prototypeWindowOpaque(request.copy(placement = PrototypePlacement.Floating())))
    assertFalse(prototypeWindowOpaque(request.copy(opaqueSurface = false)))
    assertFalse(
      prototypeWindowOpaque(PrototypeRequest(placement = PrototypePlacement.Fullscreen())),
    )
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeOpaqueWindowTest {
  private fun spec(
    background: PrototypeModeValue? = PrototypeModeValue.Single("#FF101010"),
    cornerRadius: PrototypeCornerRadius? = null,
    scrim: String? = null,
    anchor: PrototypeAnchor? = null,
  ) =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement(scrim = scrim?.let(PrototypeModeValue::Single))),
      root =
        PrototypeBoxNode(
          style =
            PrototypeStyle(
              width = PrototypeDimension.Fill,
              height = PrototypeDimension.Fill,
              background = background,
              cornerRadius = cornerRadius,
            ),
          anchor = anchor,
          children = emptyList(),
        ),
    )

  @Test
  fun `request marks a filling solid opaque root as opaque without considering host chrome`() {
    val request = mapPrototypeSpec(spec()).request()
    assertTrue(request.opaqueSurface)
    // Direct render-model requests retain the legacy bar; host eligibility is checked separately.
    assertFalse(prototypeWindowOpaque(request))
    assertTrue(prototypeWindowOpaque(request.copy(chrome = PrototypeWindowChrome.NONE)))
  }

  @Test
  fun `root with conditional styles cannot opt into an opaque surface`() {
    val spec = spec()
    val root = spec.root as PrototypeBoxNode
    val conditional =
      root.copy(
        styleWhen =
          listOf(
            PrototypeStyleWhen(
              PrototypeCondition(key = "dim", equals = PrototypeScalar.BooleanValue(true)),
              PrototypeStyle(background = PrototypeModeValue.Single("#80101010")),
            ),
          ),
      )
    val model = mapPrototypeSpec(spec.copy(root = conditional))
    assertTrue(prototypeWindowMetadata(model, dismissBarDrawn = false).opaque)
    assertFalse(model.request().opaqueSurface)
    assertTrue(
      mapPrototypeSpec(spec.copy(root = root.copy(styleWhen = emptyList())))
        .request()
        .opaqueSurface,
    )
  }

  @Test
  fun `visible root with a visibility condition cannot opt into an opaque surface`() {
    val spec = spec()
    val root =
      (spec.root as PrototypeBoxNode).copy(
        visibleWhen =
          PrototypeCondition(key = "shown", equals = PrototypeScalar.BooleanValue(true)),
      )
    val model =
      mapPrototypeSpec(
        spec.copy(root = root, state = mapOf("shown" to PrototypeScalar.BooleanValue(true))),
      )
    assertTrue(model.root.visible)
    assertTrue(prototypeWindowMetadata(model, dismissBarDrawn = false).opaque)
    assertFalse(model.request().opaqueSurface)
  }

  @Test
  fun `hidden root cannot opt into an opaque surface`() {
    val model = mapPrototypeSpec(spec())
    assertFalse(model.copy(root = model.root.copy(visible = false)).request().opaqueSurface)
  }

  @Test
  fun `transparent translucent rounded and anchored roots do not qualify as opaque surfaces`() {
    listOf(
        spec(background = null),
        spec(background = PrototypeModeValue.Single("#00101010")),
        spec(background = PrototypeModeValue.Single("#80101010")),
        spec(cornerRadius = PrototypeCornerRadius.Dp(48.0)),
        spec(anchor = PrototypeBoundsAnchor(PrototypeBounds(40.0, 40.0, 80.0, 80.0))),
      )
      .forEach { assertFalse(mapPrototypeSpec(it).request().opaqueSurface) }
  }

  @Test
  fun `scrim-only surface requires a fully opaque scrim`() {
    assertFalse(
      mapPrototypeSpec(spec(background = null, scrim = "#66000000")).request().opaqueSurface,
    )
    assertTrue(
      mapPrototypeSpec(spec(background = null, scrim = "#FF000000")).request().opaqueSurface,
    )
  }

  @Test
  fun `request checks all reachable palettes rather than the currently shown mode`() {
    val mixed = spec(background = PrototypeModeValue.Modes("#FF101010", "#80101010"))
    assertFalse(mapPrototypeSpec(mixed).request().opaqueSurface)
    assertTrue(
      mapPrototypeSpec(mixed.copy(theme = PrototypeSpecTheme(mode = "light")))
        .request()
        .opaqueSurface,
    )
    assertTrue(
      mapPrototypeSpec(spec(background = PrototypeModeValue.Modes("#FF101010", "#FF202020")))
        .request()
        .opaqueSurface,
    )
  }
}
