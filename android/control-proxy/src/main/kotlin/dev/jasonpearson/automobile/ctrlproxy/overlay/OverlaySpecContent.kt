package dev.jasonpearson.automobile.ctrlproxy.overlay

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.OverlayDimension

val OverlayRole = SemanticsPropertyKey<String>("OverlayRole")

/** No tap handlers, device reads or state mutation. Insets and density come from Compose. */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun OverlaySpecContent(root: OverlayRenderNode) {
  Box(Modifier.semantics { testTagsAsResourceId = true }) { RenderOverlayNode(root) }
}

@Composable
private fun RenderOverlayNode(node: OverlayRenderNode) {
  if (!node.visible) return
  val modifier = overlayNodeModifier(node)
  when (node.role) {
    "box" ->
      Box(modifier, contentAlignment = node.style.alignment) {
        node.children.forEach { RenderOverlayNode(it) }
      }
    "row" ->
      Row(
        modifier,
        horizontalArrangement = overlayHorizontalArrangement(node.style.source),
        verticalAlignment = node.style.verticalAlignment,
      ) {
        node.children.forEach { RenderOverlayNode(it) }
      }
    "column" ->
      Column(
        modifier,
        verticalArrangement = overlayVerticalArrangement(node.style.source),
        horizontalAlignment = node.style.horizontalAlignment,
      ) {
        node.children.forEach { RenderOverlayNode(it) }
      }
    "text" ->
      Text(
        node.text,
        modifier,
        color = node.style.color,
        fontSize =
          with(LocalDensity.current) { (node.style.source.textSize ?: 14.0).toFloat().dp.toSp() },
        fontWeight = node.style.fontWeight,
        fontFamily = node.style.fontFamily,
        textAlign = node.style.textAlign,
        maxLines = node.style.source.maxLines ?: Int.MAX_VALUE,
      )
    "icon" -> {
      val icon = overlayIcon(node.iconName)
      if (icon != null)
        Icon(icon, contentDescription = null, modifier = modifier, tint = node.style.color)
      else
        Box(
          modifier.defaultMinSize(24.dp, 24.dp).background(node.style.background ?: Color.LightGray)
        )
    }
    "image" ->
      Box(
        modifier.defaultMinSize(24.dp, 24.dp).background(node.style.background ?: Color.LightGray)
      )
    // Spacer and #9300 nodes are empty boxes retaining style and accessibility semantics.
    else -> Box(modifier)
  }
}

@Composable
private fun overlayNodeModifier(node: OverlayRenderNode): Modifier {
  val style = node.style.source
  var modifier: Modifier = Modifier
  modifier = dimensionModifier(modifier, style.width, horizontal = true)
  modifier = dimensionModifier(modifier, style.height, horizontal = false)
  modifier = modifier.alpha((style.alpha ?: 1.0).toFloat())
  val shape = RoundedCornerShape((style.cornerRadius ?: 0.0).toFloat().dp)
  if (style.cornerRadius != null) modifier = modifier.clip(shape)
  node.style.background?.let { modifier = modifier.background(it, shape) }
  style.border?.let {
    modifier = modifier.border(it.width.toFloat().dp, checkNotNull(node.style.borderColor), shape)
  }
  node.safeArea?.let { safeArea ->
    var insets: WindowInsets = WindowInsets(0, 0, 0, 0)
    for (type in safeArea.types) {
      insets =
        insets.union(
          when (type) {
            "systemBars" -> WindowInsets.systemBars
            "cutout" -> WindowInsets.displayCutout
            "ime" -> WindowInsets.ime
            else -> WindowInsets(0, 0, 0, 0)
          }
        )
    }
    val sides =
      safeArea.edges
        .map { edge ->
          when (edge) {
            "top" -> WindowInsetsSides.Top
            "bottom" -> WindowInsetsSides.Bottom
            "start" -> WindowInsetsSides.Start
            "end" -> WindowInsetsSides.End
            else -> WindowInsetsSides.Start
          }
        }
        .reduce { sides, next -> sides + next }
    modifier = modifier.windowInsetsPadding(insets.only(sides))
  }
  style.padding?.let {
    modifier =
      modifier.padding(
        start = (it.start ?: 0.0).toFloat().dp,
        top = (it.top ?: 0.0).toFloat().dp,
        end = (it.end ?: 0.0).toFloat().dp,
        bottom = (it.bottom ?: 0.0).toFloat().dp,
      )
  }
  return modifier.semantics {
    text = AnnotatedString(node.text)
    this[OverlayRole] = node.role
    if (node.role == "icon" || node.role == "image") role = Role.Image
    // Compose has no native role for text or layout containers. Preserve the node kind as a label
    // for empty primitives as well as a custom semantic role; no button role implies tap support.
    contentDescription = node.text.ifEmpty { node.role }
    node.testTag?.let { testTag = it }
  }
}

private fun dimensionModifier(
  modifier: Modifier,
  size: OverlayDimension?,
  horizontal: Boolean,
): Modifier =
  when (size) {
    OverlayDimension.Fill -> if (horizontal) modifier.fillMaxWidth() else modifier.fillMaxHeight()
    is OverlayDimension.Dp ->
      if (horizontal) modifier.width(size.dp.toFloat().dp)
      else modifier.height(size.dp.toFloat().dp)
    OverlayDimension.Wrap,
    null -> if (horizontal) modifier.wrapContentWidth() else modifier.wrapContentHeight()
  }
