package dev.jasonpearson.automobile.design.system.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

// AutoMobile Design System Shapes.
// Chunkier, softer corners than the Material default scale — the token-layer
// foundation of the hand-drawn crayon look. True irregular "wobble" borders are
// layered on top in the design-system components (follow-up item). See
// docs/design-docs/playground-design-system.md.
val AutoMobileShapes =
  Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(18.dp),
    large = RoundedCornerShape(26.dp),
    extraLarge = RoundedCornerShape(40.dp),
  )

// Additional custom shapes for specific use cases
object AutoMobileCustomShapes {
  val button = RoundedCornerShape(14.dp)
  val card = RoundedCornerShape(18.dp)
  val bottomSheet = RoundedCornerShape(topStart = 26.dp, topEnd = 26.dp)
  val dialog = RoundedCornerShape(26.dp)
  val textField = RoundedCornerShape(12.dp)
}
