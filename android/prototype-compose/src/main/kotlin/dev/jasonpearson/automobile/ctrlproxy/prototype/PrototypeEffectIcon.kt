package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import dev.jasonpearson.automobile.protocol.PrototypeIconNode

@Composable
internal fun PrototypeEffectIcon(
  icon: ImageVector,
  node: PrototypeRenderNode,
  modifier: Modifier,
  tint: Color,
  glyph: @Composable (ImageVector, Modifier) -> Unit = { image, glyphModifier ->
    Icon(image, contentDescription = null, modifier = glyphModifier, tint = tint)
  },
) {
  val type = (node.source as? PrototypeIconNode)?.effect?.type
  val crossfade =
    LocalPrototypeMotion.current &&
      LocalPrototypeMotionProfile.current != PrototypeMotionProfile.OFF &&
      (type == "replace" ||
        (type == "drawOn" && LocalPrototypeMotionProfile.current == PrototypeMotionProfile.FULL))
  if (crossfade) {
    Crossfade(icon, animationSpec = tween(600), label = "prototypeIconReplace") { image ->
      glyph(image, modifier)
    }
  } else glyph(icon, modifier)
}
