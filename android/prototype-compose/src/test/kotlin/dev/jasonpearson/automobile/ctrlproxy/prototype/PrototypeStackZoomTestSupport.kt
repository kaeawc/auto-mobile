package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.*
import dev.jasonpearson.automobile.protocol.*

/** ScaleToBounds scales pixels while preserving the destination's lookahead layout. */
internal fun stackZoomInkBounds(root: SemanticsNodeInteraction): Rect {
  val pixels = root.captureToImage().toPixelMap()
  var left = pixels.width
  var top = pixels.height
  var right = 0
  var bottom = 0
  for (y in 0 until pixels.height) {
    for (x in 0 until pixels.width) {
      val color = pixels[x, y]
      if (maxOf(color.red, color.blue) - color.green > 0.1f) {
        left = minOf(left, x)
        top = minOf(top, y)
        right = maxOf(right, x + 1)
        bottom = maxOf(bottom, y + 1)
      }
    }
  }
  return Rect(left.toFloat(), top.toFloat(), right.toFloat(), bottom.toFloat())
}

internal fun stackZoomRuntime(motion: String) =
  PrototypeRuntime(
    PrototypeSpec(
      id = "zoom",
      motion = motion,
      window = PrototypeWindow(PrototypeFullscreenPlacement()),
      root =
        PrototypeStackNode(
          id = "nav",
          start = "home",
          transition = PrototypeTransition("zoom"),
          screens =
            mapOf(
              "home" to
                PrototypeBoxNode(
                  children =
                    listOf(
                      PrototypeBoxNode(
                        testTag = "hero",
                        sharedKey = "hero",
                        children = emptyList(),
                        style =
                          PrototypeStyle(
                            width = PrototypeDimension.Dp(60.0),
                            height = PrototypeDimension.Dp(40.0),
                            background = PrototypeModeValue.Single("#ff0000"),
                          ),
                      ),
                    ),
                ),
              "detail" to
                PrototypeBoxNode(
                  testTag = "detail",
                  children = emptyList(),
                  style =
                    PrototypeStyle(
                      width = PrototypeDimension.Dp(240.0),
                      height = PrototypeDimension.Dp(200.0),
                      background = PrototypeModeValue.Single("#0000ff"),
                    ),
                ),
            ),
        ),
    ),
    nextSequence = { 1L },
  )
